ALTER TYPE public.proposal_kind ADD VALUE IF NOT EXISTS 'fund_asset';
ALTER TYPE public.proposal_kind ADD VALUE IF NOT EXISTS 'set_fee';

CREATE TABLE public.funding_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submitted_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  asset_slug text NOT NULL UNIQUE,
  name text NOT NULL,
  category text NOT NULL,
  issuer text NOT NULL,
  location text,
  description text,
  target_lovelace bigint NOT NULL DEFAULT 0,
  min_deposit_lovelace bigint NOT NULL DEFAULT 10000000,
  maturity_months integer,
  reporting_cadence text,
  evidence_urls text[] NOT NULL DEFAULT '{}'::text[],
  proposed_fee_bps integer NOT NULL DEFAULT 0,
  treasury_address text,
  status text NOT NULL DEFAULT 'draft',
  proposal_id uuid REFERENCES public.governance_proposals(id) ON DELETE SET NULL,
  asset_id text REFERENCES public.assets(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.funding_requests TO anon;
GRANT SELECT, INSERT, UPDATE ON public.funding_requests TO authenticated;
GRANT ALL ON public.funding_requests TO service_role;

ALTER TABLE public.funding_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read funding requests"
  ON public.funding_requests FOR SELECT TO anon, authenticated USING (true);

CREATE POLICY "Users submit own funding requests"
  ON public.funding_requests FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = submitted_by);

CREATE POLICY "Submitters edit their drafts"
  ON public.funding_requests FOR UPDATE TO authenticated
  USING (auth.uid() = submitted_by AND status = 'draft')
  WITH CHECK (auth.uid() = submitted_by);

CREATE POLICY "Admins manage funding requests"
  ON public.funding_requests FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE TRIGGER set_funding_requests_updated_at
  BEFORE UPDATE ON public.funding_requests
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.vault_fee_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id text NOT NULL REFERENCES public.assets(id) ON DELETE CASCADE,
  vault_version integer NOT NULL,
  network text NOT NULL DEFAULT 'preprod',
  fee_bps integer NOT NULL DEFAULT 0,
  treasury_address text NOT NULL,
  treasury_pkh text,
  effective_from_slot bigint,
  set_tx_hash text,
  proposal_id uuid REFERENCES public.governance_proposals(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.vault_fee_schedules TO anon;
GRANT SELECT ON public.vault_fee_schedules TO authenticated;
GRANT ALL ON public.vault_fee_schedules TO service_role;

ALTER TABLE public.vault_fee_schedules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read vault fee schedules"
  ON public.vault_fee_schedules FOR SELECT TO anon, authenticated USING (true);

CREATE POLICY "Admins manage vault fee schedules"
  ON public.vault_fee_schedules FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Operators record vault fee schedules"
  ON public.vault_fee_schedules FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'operator'));

CREATE TRIGGER set_vault_fee_schedules_updated_at
  BEFORE UPDATE ON public.vault_fee_schedules
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE INDEX idx_vault_fee_schedules_asset ON public.vault_fee_schedules (asset_id, vault_version);
CREATE INDEX idx_funding_requests_status ON public.funding_requests (status);