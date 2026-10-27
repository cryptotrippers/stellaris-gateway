-- Sprint 1 E01 — close the funding-path and issuer forgery holes found in the
-- 26 Oct 2026 engineering audit (section "Can an unauthorised client do this?").
--
-- Every rule below applies to callers who hold a user JWT and are not admins.
-- Admins and the backend (service role, where auth.uid() is NULL) keep their
-- existing powers; stage moves made on a user's behalf go through server
-- functions that check the user first and then write with the service role.
--
--  1. funding_requests: a user can only create a draft or submitted request,
--     can only edit their own draft, can't skip stages, can't attach a
--     proposal or asset, can't claim someone else's issuer, and can't change
--     the payout address once the request has left draft (G-2, payout lock).
--  2. issuers: the verification guard now also runs on INSERT, so a user can't
--     create an issuer that is already verified; changing legal identity on a
--     verified issuer sends it back to pending (G-3, G-5).
--  3. funding_request_checklist: editing the evidence on a verified or
--     rejected item sends it back to submitted for review (G-4).
--  4. yield_accruals / vault_fee_schedules: operators can no longer insert
--     rows directly; only chain-verified server functions write them.

-- ---------------------------------------------------------------------------
-- Shared: is the caller an admin or the backend?
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_privileged_writer()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  -- No user JWT: service role or a direct database session (migrations).
  -- Anonymous callers also have no uid, but no anon role may write to the
  -- tables guarded below (their RLS policies are for authenticated only).
  IF auth.uid() IS NULL THEN
    RETURN true;
  END IF;
  RETURN public.has_role(auth.uid(), 'admin');
END;
$$;

REVOKE ALL ON FUNCTION public.is_privileged_writer() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_privileged_writer() TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 1. funding_requests
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_funding_request()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.status <> 'draft'
     AND NEW.treasury_address IS DISTINCT FROM OLD.treasury_address
     AND auth.uid() IS NOT NULL THEN
    -- Payout lock: once a request has left draft, nobody signed in (admin
    -- included) changes where the money goes.
    RAISE EXCEPTION 'The payout address is locked once a funding request leaves draft.';
  END IF;

  IF public.is_privileged_writer() THEN
    IF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status AND auth.uid() IS NOT NULL THEN
      INSERT INTO public.security_audit_log (user_id, action, detail)
      VALUES (auth.uid(), 'funding_request_status_changed',
              jsonb_build_object('funding_request_id', NEW.id,
                                 'from', OLD.status, 'to', NEW.status));
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.issuer_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.issuer_id IS DISTINCT FROM OLD.issuer_id)
     AND NOT EXISTS (SELECT 1 FROM public.issuers i
                      WHERE i.id = NEW.issuer_id AND i.owner_user_id = auth.uid()) THEN
    RAISE EXCEPTION 'You can only link a funding request to an issuer profile you own.';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status NOT IN ('draft', 'submitted') THEN
      RAISE EXCEPTION 'A new funding request can only be a draft or submitted for review.';
    END IF;
    IF NEW.proposal_id IS NOT NULL OR NEW.asset_id IS NOT NULL THEN
      RAISE EXCEPTION 'A governance proposal or asset is attached by the platform, not by the submitter.';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE by the submitter (RLS already limits them to their own drafts).
  IF OLD.status <> 'draft' THEN
    RAISE EXCEPTION 'Only a draft funding request can be edited by its submitter.';
  END IF;
  IF NEW.status NOT IN ('draft', 'submitted') THEN
    RAISE EXCEPTION 'You can save a draft or submit it for review; later stages are set by the platform.';
  END IF;
  IF NEW.submitted_by IS DISTINCT FROM OLD.submitted_by THEN
    RAISE EXCEPTION 'A funding request cannot be handed to another account.';
  END IF;
  IF NEW.proposal_id IS DISTINCT FROM OLD.proposal_id OR NEW.asset_id IS DISTINCT FROM OLD.asset_id THEN
    RAISE EXCEPTION 'A governance proposal or asset is attached by the platform, not by the submitter.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_funding_request ON public.funding_requests;
CREATE TRIGGER trg_guard_funding_request
  BEFORE INSERT OR UPDATE ON public.funding_requests
  FOR EACH ROW EXECUTE FUNCTION public.guard_funding_request();

-- ---------------------------------------------------------------------------
-- 2. issuers — the verification guard now covers INSERT as well as UPDATE
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_issuer_verification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  privileged boolean := public.is_privileged_writer();
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT privileged THEN
      -- A new profile always starts unverified, whatever the client sent.
      NEW.verification_status := 'unverified';
      NEW.verified_at := NULL;
    END IF;
    RETURN NEW;
  END IF;

  -- G-5: a changed legal identity is a different issuer until re-checked.
  IF NOT privileged
     AND OLD.verification_status IN ('verified', 'rejected')
     AND NEW.verification_status IS NOT DISTINCT FROM OLD.verification_status
     AND (NEW.legal_name IS DISTINCT FROM OLD.legal_name
          OR NEW.jurisdiction IS DISTINCT FROM OLD.jurisdiction
          OR NEW.registration_number IS DISTINCT FROM OLD.registration_number
          OR NEW.wrapper_type IS DISTINCT FROM OLD.wrapper_type) THEN
    NEW.verification_status := 'pending';
  END IF;

  IF NEW.verification_status IS DISTINCT FROM OLD.verification_status THEN
    IF NEW.verification_status IN ('verified', 'rejected') AND NOT privileged THEN
      RAISE EXCEPTION 'Only an admin can verify or reject an issuer.';
    END IF;
    NEW.verified_at := CASE WHEN NEW.verification_status = 'verified' THEN now() ELSE NULL END;
    INSERT INTO public.issuer_verifications (issuer_id, status, decided_by)
    VALUES (NEW.id, NEW.verification_status, auth.uid());
    IF auth.uid() IS NOT NULL THEN
      INSERT INTO public.security_audit_log (user_id, action, detail)
      VALUES (auth.uid(), 'issuer_verification_changed',
              jsonb_build_object('issuer_id', NEW.id, 'status', NEW.verification_status));
    END IF;
  ELSIF NOT privileged AND NEW.verified_at IS DISTINCT FROM OLD.verified_at THEN
    NEW.verified_at := OLD.verified_at;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_issuer_verification ON public.issuers;
CREATE TRIGGER trg_guard_issuer_verification
  BEFORE INSERT OR UPDATE ON public.issuers
  FOR EACH ROW EXECUTE FUNCTION public.guard_issuer_verification();

-- ---------------------------------------------------------------------------
-- 3. funding_request_checklist — edited evidence goes back for review
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_checklist_verification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  -- G-4: new evidence on a reviewed item needs a fresh review.
  IF TG_OP = 'UPDATE'
     AND NOT public.is_privileged_writer()
     AND OLD.status IN ('verified', 'rejected')
     AND NEW.status IS NOT DISTINCT FROM OLD.status
     AND NEW.evidence_url IS DISTINCT FROM OLD.evidence_url THEN
    NEW.status := 'submitted';
  END IF;

  IF NEW.status IN ('verified', 'rejected')
     AND (TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status) THEN
    IF NOT public.has_role(auth.uid(), 'admin') THEN
      RAISE EXCEPTION 'Only an admin can verify or reject a checklist item.';
    END IF;
    NEW.verified_by := auth.uid();
    NEW.verified_at := now();
    INSERT INTO public.security_audit_log (user_id, action, detail)
    VALUES (auth.uid(), 'checklist_item_reviewed',
            jsonb_build_object('funding_request_id', NEW.funding_request_id,
                               'item_key', NEW.item_key, 'status', NEW.status));
  ELSIF TG_OP = 'UPDATE' AND NEW.status NOT IN ('verified', 'rejected')
        AND NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.verified_by := NULL;
    NEW.verified_at := NULL;
  ELSIF NOT public.is_privileged_writer()
        AND (NEW.verified_by IS DISTINCT FROM CASE WHEN TG_OP = 'UPDATE' THEN OLD.verified_by END
             OR NEW.verified_at IS DISTINCT FROM CASE WHEN TG_OP = 'UPDATE' THEN OLD.verified_at END) THEN
    -- Reviewer fields are only ever written by the review itself.
    NEW.verified_by := CASE WHEN TG_OP = 'UPDATE' THEN OLD.verified_by END;
    NEW.verified_at := CASE WHEN TG_OP = 'UPDATE' THEN OLD.verified_at END;
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. Ledger-like tables: no direct operator inserts
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Operators record accruals" ON public.yield_accruals;
DROP POLICY IF EXISTS "Operators record vault fee schedules" ON public.vault_fee_schedules;
