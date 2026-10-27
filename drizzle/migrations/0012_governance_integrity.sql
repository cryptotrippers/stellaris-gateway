-- Sprint 2 E12 findings — holes found by the role × table matrix (27 Oct 2026).
--
-- A signed-in user calling the database directly with the public key could:
--  G-7  create a governance proposal that is already "passed" (any kind);
--  G-8  as an operator, set any proposal to "passed" without a vote;
--  G-9  cast or change a vote after the voting window closed (finalisation
--       re-reads votes, so this changes the result);
--  G-10 set their own user_profiles.kyc_status to "verified";
--  G-11 edit or delete an impact attestation, or its metrics, after an admin
--       published it;
--  G-12 un-revoke one of their own security sessions.
--
-- Proposals and votes are now written by the server (service role) after its
-- own checks, as funding requests are since 0009; triggers refuse the rest for
-- every signed-in non-admin. Admins and the backend (auth.uid() IS NULL) keep
-- their powers; is_privileged_writer() comes from 0009.

-- ---------------------------------------------------------------------------
-- G-7 / G-8: governance_proposals
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Users create own proposals" ON public.governance_proposals;

CREATE OR REPLACE FUNCTION public.guard_governance_proposal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF public.is_privileged_writer() THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    RAISE EXCEPTION 'Proposals are created through the platform, not directly.';
  END IF;
  -- An operator may only record the execution of a proposal that passed.
  IF OLD.status = 'passed' AND NEW.status = 'executed'
     AND (to_jsonb(NEW) - ARRAY['status', 'executed_tx_hash', 'executed_at', 'executed_epoch', 'updated_at'])
       = (to_jsonb(OLD) - ARRAY['status', 'executed_tx_hash', 'executed_at', 'executed_epoch', 'updated_at']) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Only recording the execution of a passed proposal is allowed here; results are set by finalisation.';
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_governance_proposal ON public.governance_proposals;
CREATE TRIGGER trg_guard_governance_proposal
  BEFORE INSERT OR UPDATE ON public.governance_proposals
  FOR EACH ROW EXECUTE FUNCTION public.guard_governance_proposal();

-- ---------------------------------------------------------------------------
-- G-9: proposal_votes — only while voting is open, only via the server
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Users insert own vote" ON public.proposal_votes;
DROP POLICY IF EXISTS "Users update own vote" ON public.proposal_votes;

CREATE OR REPLACE FUNCTION public.guard_proposal_vote()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.proposal_id IS DISTINCT FROM OLD.proposal_id
       OR NEW.voter_user_id IS DISTINCT FROM OLD.voter_user_id THEN
      RAISE EXCEPTION 'A ballot cannot be moved to another proposal or voter.';
    END IF;
  END IF;
  -- Applies to everyone, the server included: no ballot outside the window.
  IF NOT EXISTS (
    SELECT 1 FROM public.governance_proposals p
     WHERE p.id = NEW.proposal_id
       AND p.status = 'active'
       AND (p.starts_at IS NULL OR p.starts_at <= now())
       AND (p.ends_at IS NULL OR p.ends_at > now())
  ) THEN
    RAISE EXCEPTION 'Voting on this proposal is not open.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_proposal_vote ON public.proposal_votes;
CREATE TRIGGER trg_guard_proposal_vote
  BEFORE INSERT OR UPDATE ON public.proposal_votes
  FOR EACH ROW EXECUTE FUNCTION public.guard_proposal_vote();

-- ---------------------------------------------------------------------------
-- G-10: user_profiles.kyc_status is set by review, never by the user
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_profile_kyc()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF public.is_privileged_writer() THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.kyc_status := 'unverified';
  ELSIF NEW.kyc_status IS DISTINCT FROM OLD.kyc_status THEN
    RAISE EXCEPTION 'KYC status is set by review, not by the account holder.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_profile_kyc ON public.user_profiles;
CREATE TRIGGER trg_guard_profile_kyc
  BEFORE INSERT OR UPDATE ON public.user_profiles
  FOR EACH ROW EXECUTE FUNCTION public.guard_profile_kyc();

-- ---------------------------------------------------------------------------
-- G-11: a published attestation and its metrics are frozen for their owner
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_published_attestation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NOT public.is_privileged_writer() AND OLD.published THEN
    RAISE EXCEPTION 'A published attestation cannot be changed or removed; ask an admin to unpublish it first.';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_published_attestation ON public.impact_attestations;
CREATE TRIGGER trg_guard_published_attestation
  BEFORE UPDATE OR DELETE ON public.impact_attestations
  FOR EACH ROW EXECUTE FUNCTION public.guard_published_attestation();

CREATE OR REPLACE FUNCTION public.guard_published_metrics()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  ids uuid[];
BEGIN
  IF public.is_privileged_writer() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    ids := ARRAY[NEW.attestation_id];
  ELSIF TG_OP = 'UPDATE' THEN
    ids := ARRAY[NEW.attestation_id, OLD.attestation_id];
  ELSE
    ids := ARRAY[OLD.attestation_id];
  END IF;
  IF EXISTS (SELECT 1 FROM public.impact_attestations a WHERE a.id = ANY (ids) AND a.published) THEN
    RAISE EXCEPTION 'Metrics of a published attestation cannot be changed.';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_published_metrics ON public.impact_metrics;
CREATE TRIGGER trg_guard_published_metrics
  BEFORE INSERT OR UPDATE OR DELETE ON public.impact_metrics
  FOR EACH ROW EXECUTE FUNCTION public.guard_published_metrics();

-- ---------------------------------------------------------------------------
-- G-12: a revoked session stays revoked
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_session_revoke()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NOT public.is_privileged_writer() AND OLD.revoked AND NOT NEW.revoked THEN
    RAISE EXCEPTION 'A revoked session cannot be restored.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_session_revoke ON public.security_sessions;
CREATE TRIGGER trg_guard_session_revoke
  BEFORE UPDATE ON public.security_sessions
  FOR EACH ROW EXECUTE FUNCTION public.guard_session_revoke();

REVOKE ALL ON FUNCTION public.guard_governance_proposal() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.guard_proposal_vote() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.guard_profile_kyc() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.guard_published_attestation() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.guard_published_metrics() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.guard_session_revoke() FROM PUBLIC, anon, authenticated;
