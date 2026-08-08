-- ---------------------------------------------------------------------------
-- Roles (separate table — never on profiles)
-- ---------------------------------------------------------------------------
CREATE TYPE public.app_role AS ENUM ('admin', 'operator', 'member');

CREATE TABLE public.user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.app_role NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, role)
);

GRANT SELECT ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND role = _role
  )
$$;

CREATE POLICY "Users read own roles"
  ON public.user_roles FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Admins read all roles"
  ON public.user_roles FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins manage roles"
  ON public.user_roles FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- ---------------------------------------------------------------------------
-- Asset vaults — binds a real-world project to its on-chain vault instance
-- ---------------------------------------------------------------------------
CREATE TABLE public.asset_vaults (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id text NOT NULL REFERENCES public.assets(id) ON DELETE CASCADE,
  vault_version integer NOT NULL,
  network text NOT NULL DEFAULT 'preprod',
  script_hash text NOT NULL,
  script_address text NOT NULL,
  operator_key_hashes text[] NOT NULL DEFAULT '{}',
  signature_threshold integer NOT NULL DEFAULT 1,
  bootstrap_tx_hash text,
  bootstrapped_at timestamptz,
  reporting_cadence text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (asset_id, vault_version, network),
  CONSTRAINT asset_vaults_threshold_positive CHECK (signature_threshold >= 1)
);

GRANT SELECT ON public.asset_vaults TO anon;
GRANT SELECT ON public.asset_vaults TO authenticated;
GRANT ALL ON public.asset_vaults TO service_role;
ALTER TABLE public.asset_vaults ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read asset vaults"
  ON public.asset_vaults FOR SELECT TO anon, authenticated
  USING (true);

CREATE POLICY "Admins manage asset vaults"
  ON public.asset_vaults FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE TRIGGER set_asset_vaults_updated_at
  BEFORE UPDATE ON public.asset_vaults
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Governance proposals — link to an asset, a type, params, and an execution tx
-- ---------------------------------------------------------------------------
CREATE TYPE public.proposal_kind AS ENUM ('accrue', 'pause', 'unpause', 'set_committee', 'signal');

ALTER TABLE public.governance_proposals
  ADD COLUMN asset_id text REFERENCES public.assets(id) ON DELETE SET NULL,
  ADD COLUMN kind public.proposal_kind NOT NULL DEFAULT 'signal',
  ADD COLUMN body text,
  ADD COLUMN author_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN params jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN starts_at timestamptz,
  ADD COLUMN executed_tx_hash text,
  ADD COLUMN executed_at timestamptz,
  ADD COLUMN executed_epoch integer;

CREATE POLICY "Operators record proposal execution"
  ON public.governance_proposals FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'operator'))
  WITH CHECK (public.has_role(auth.uid(), 'operator'));

CREATE POLICY "Admins manage proposals"
  ON public.governance_proposals FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- ---------------------------------------------------------------------------
-- Yield accruals — cache of real on-chain Accrue transactions
-- ---------------------------------------------------------------------------
CREATE TABLE public.yield_accruals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id text NOT NULL REFERENCES public.assets(id) ON DELETE CASCADE,
  vault_version integer NOT NULL,
  network text NOT NULL DEFAULT 'preprod',
  tx_hash text NOT NULL,
  epoch integer NOT NULL,
  amount_lovelace bigint NOT NULL,
  total_assets_after bigint NOT NULL,
  total_shares_after bigint NOT NULL,
  share_price_before numeric,
  share_price_after numeric,
  block_height bigint,
  block_time timestamptz NOT NULL,
  proposal_id uuid REFERENCES public.governance_proposals(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tx_hash, network)
);

GRANT SELECT ON public.yield_accruals TO anon;
GRANT SELECT ON public.yield_accruals TO authenticated;
GRANT ALL ON public.yield_accruals TO service_role;
ALTER TABLE public.yield_accruals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read yield accruals"
  ON public.yield_accruals FOR SELECT TO anon, authenticated
  USING (true);

CREATE POLICY "Operators record accruals"
  ON public.yield_accruals FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'operator'));

CREATE INDEX yield_accruals_asset_epoch_idx
  ON public.yield_accruals (asset_id, epoch DESC);