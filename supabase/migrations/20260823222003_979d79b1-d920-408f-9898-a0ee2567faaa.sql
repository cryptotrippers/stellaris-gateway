-- ============ issuers ============
CREATE TABLE public.issuers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  legal_name text NOT NULL,
  jurisdiction text NOT NULL,
  registration_number text,
  contact_email text,
  website text,
  wrapper_type text NOT NULL DEFAULT 'none'
    CHECK (wrapper_type IN ('spv','cooperative','trust','company','foundation','none')),
  verification_status text NOT NULL DEFAULT 'unverified'
    CHECK (verification_status IN ('unverified','pending','verified','rejected')),
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.issuers TO anon;
GRANT SELECT, INSERT, UPDATE ON public.issuers TO authenticated;
GRANT ALL ON public.issuers TO service_role;
ALTER TABLE public.issuers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Issuer profiles are public" ON public.issuers FOR SELECT USING (true);
CREATE POLICY "Owners create their issuer profile" ON public.issuers
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = owner_user_id);
CREATE POLICY "Owners and admins edit issuer profiles" ON public.issuers
  FOR UPDATE TO authenticated
  USING (auth.uid() = owner_user_id OR public.has_role(auth.uid(), 'admin'))
  WITH CHECK (auth.uid() = owner_user_id OR public.has_role(auth.uid(), 'admin'));

CREATE TRIGGER set_issuers_updated_at BEFORE UPDATE ON public.issuers
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============ issuer verification history ============
CREATE TABLE public.issuer_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issuer_id uuid NOT NULL REFERENCES public.issuers(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('unverified','pending','verified','rejected')),
  note text,
  decided_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.issuer_verifications TO anon;
GRANT SELECT ON public.issuer_verifications TO authenticated;
GRANT ALL ON public.issuer_verifications TO service_role;
ALTER TABLE public.issuer_verifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Verification history is public" ON public.issuer_verifications
  FOR SELECT USING (true);

-- Only admins may move an issuer into/out of verified or rejected.
CREATE OR REPLACE FUNCTION public.guard_issuer_verification()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.verification_status IS DISTINCT FROM OLD.verification_status THEN
    IF NEW.verification_status IN ('verified','rejected')
       AND NOT public.has_role(auth.uid(), 'admin') THEN
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
  END IF;
  RETURN NEW;
END; $$;

CREATE TRIGGER trg_guard_issuer_verification BEFORE UPDATE ON public.issuers
  FOR EACH ROW EXECUTE FUNCTION public.guard_issuer_verification();

-- ============ funding requests -> issuer ============
ALTER TABLE public.funding_requests
  ADD COLUMN issuer_id uuid REFERENCES public.issuers(id) ON DELETE SET NULL;

-- ============ verification checklist ============
CREATE TABLE public.funding_request_checklist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  funding_request_id uuid NOT NULL REFERENCES public.funding_requests(id) ON DELETE CASCADE,
  item_key text NOT NULL CHECK (item_key IN (
    'legal_wrapper','asset_title','operating_licence','insurance',
    'offtake_agreement','technical_audit','impact_methodology')),
  status text NOT NULL DEFAULT 'missing'
    CHECK (status IN ('missing','submitted','verified','rejected')),
  evidence_url text,
  note text,
  verified_by uuid REFERENCES auth.users(id),
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (funding_request_id, item_key)
);

GRANT SELECT ON public.funding_request_checklist TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.funding_request_checklist TO authenticated;
GRANT ALL ON public.funding_request_checklist TO service_role;
ALTER TABLE public.funding_request_checklist ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Checklists are public" ON public.funding_request_checklist
  FOR SELECT USING (true);
CREATE POLICY "Submitters and admins add checklist items" ON public.funding_request_checklist
  FOR INSERT TO authenticated WITH CHECK (
    public.has_role(auth.uid(), 'admin')
    OR EXISTS (SELECT 1 FROM public.funding_requests f
               WHERE f.id = funding_request_id AND f.submitted_by = auth.uid())
  );
CREATE POLICY "Submitters and admins edit checklist items" ON public.funding_request_checklist
  FOR UPDATE TO authenticated USING (
    public.has_role(auth.uid(), 'admin')
    OR EXISTS (SELECT 1 FROM public.funding_requests f
               WHERE f.id = funding_request_id AND f.submitted_by = auth.uid())
  ) WITH CHECK (
    public.has_role(auth.uid(), 'admin')
    OR EXISTS (SELECT 1 FROM public.funding_requests f
               WHERE f.id = funding_request_id AND f.submitted_by = auth.uid())
  );

CREATE OR REPLACE FUNCTION public.guard_checklist_verification()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status IN ('verified','rejected')
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
  ELSIF TG_OP = 'UPDATE' AND NEW.status NOT IN ('verified','rejected')
        AND NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.verified_by := NULL;
    NEW.verified_at := NULL;
  END IF;
  RETURN NEW;
END; $$;

CREATE TRIGGER trg_guard_checklist_verification
  BEFORE INSERT OR UPDATE ON public.funding_request_checklist
  FOR EACH ROW EXECUTE FUNCTION public.guard_checklist_verification();

CREATE TRIGGER set_checklist_updated_at BEFORE UPDATE ON public.funding_request_checklist
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============ impact attestations ============
CREATE TABLE public.impact_attestations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  funding_request_id uuid NOT NULL REFERENCES public.funding_requests(id) ON DELETE CASCADE,
  attester text NOT NULL,
  methodology text NOT NULL,
  reporting_cadence text NOT NULL DEFAULT 'quarterly',
  evidence_url text,
  published boolean NOT NULL DEFAULT false,
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.impact_attestations TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.impact_attestations TO authenticated;
GRANT ALL ON public.impact_attestations TO service_role;
ALTER TABLE public.impact_attestations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Published attestations are public" ON public.impact_attestations
  FOR SELECT USING (published OR auth.uid() = created_by OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Owners create attestations" ON public.impact_attestations
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = created_by);
CREATE POLICY "Owners and admins edit attestations" ON public.impact_attestations
  FOR UPDATE TO authenticated
  USING (auth.uid() = created_by OR public.has_role(auth.uid(), 'admin'))
  WITH CHECK (auth.uid() = created_by OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Owners delete their attestations" ON public.impact_attestations
  FOR DELETE TO authenticated USING (auth.uid() = created_by);

CREATE TRIGGER set_impact_attestations_updated_at BEFORE UPDATE ON public.impact_attestations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.impact_metrics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attestation_id uuid NOT NULL REFERENCES public.impact_attestations(id) ON DELETE CASCADE,
  metric_name text NOT NULL,
  unit text NOT NULL,
  baseline numeric,
  target numeric,
  measurement_method text,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.impact_metrics TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.impact_metrics TO authenticated;
GRANT ALL ON public.impact_metrics TO service_role;
ALTER TABLE public.impact_metrics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Metrics follow their attestation" ON public.impact_metrics
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM public.impact_attestations a WHERE a.id = attestation_id
      AND (a.published OR a.created_by = auth.uid() OR public.has_role(auth.uid(), 'admin'))));
CREATE POLICY "Owners add metrics" ON public.impact_metrics
  FOR INSERT TO authenticated WITH CHECK (EXISTS (
    SELECT 1 FROM public.impact_attestations a WHERE a.id = attestation_id
      AND a.created_by = auth.uid()));
CREATE POLICY "Owners edit metrics" ON public.impact_metrics
  FOR UPDATE TO authenticated USING (EXISTS (
    SELECT 1 FROM public.impact_attestations a WHERE a.id = attestation_id
      AND a.created_by = auth.uid()))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.impact_attestations a WHERE a.id = attestation_id
      AND a.created_by = auth.uid()));
CREATE POLICY "Owners delete metrics" ON public.impact_metrics
  FOR DELETE TO authenticated USING (EXISTS (
    SELECT 1 FROM public.impact_attestations a WHERE a.id = attestation_id
      AND a.created_by = auth.uid()));

CREATE INDEX idx_checklist_request ON public.funding_request_checklist (funding_request_id);
CREATE INDEX idx_attestations_request ON public.impact_attestations (funding_request_id);
CREATE INDEX idx_metrics_attestation ON public.impact_metrics (attestation_id);
CREATE INDEX idx_issuers_owner ON public.issuers (owner_user_id);