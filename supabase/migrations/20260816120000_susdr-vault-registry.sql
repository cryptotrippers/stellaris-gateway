-- ---------------------------------------------------------------------------
-- sUSDr vault registry, position watchlist, and accrual cache.
--
-- Mirrors the existing asset_vaults / yield_accruals pattern exactly
-- (public read, admin/operator-only writes via has_role()), reusing the
-- project's existing public.user_roles / public.app_role / public.has_role()
-- RBAC — this is a new PRODUCT living in the same repo (see
-- contracts/susdr-vault/DESIGN.md, "Where this lives"), not a new Supabase
-- project, so it shares the same role system rather than duplicating it.
--
-- Unlike asset_vaults (one vault per marketplace asset), sUSDr is a single
-- global vault over one USDr policy, so there is no per-row FK to
-- public.assets here.
-- ---------------------------------------------------------------------------

CREATE TABLE public.susdr_vaults (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vault_version integer NOT NULL,
  network text NOT NULL DEFAULT 'preprod',
  usdr_policy_id text NOT NULL,
  -- Structurally the same value as susdr_policy_id — susdr_vault's mint and
  -- spend handlers share one script hash (contracts/susdr-vault/DESIGN.md,
  -- "One script, two purposes"). Both columns are stored so a reader never
  -- has to re-derive one from the other to display or verify either.
  script_hash text NOT NULL,
  susdr_policy_id text NOT NULL,
  script_address text NOT NULL,
  operator_key_hashes text[] NOT NULL DEFAULT '{}',
  signature_threshold integer NOT NULL DEFAULT 1,
  fee_bps integer NOT NULL DEFAULT 0,
  treasury_key_hash text,
  bootstrap_tx_hash text,
  bootstrapped_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (usdr_policy_id, vault_version, network),
  CONSTRAINT susdr_vaults_threshold_positive CHECK (signature_threshold >= 1),
  CONSTRAINT susdr_vaults_fee_bps_capped CHECK (fee_bps >= 0 AND fee_bps <= 500),
  CONSTRAINT susdr_vaults_hash_matches_policy CHECK (script_hash = susdr_policy_id)
);

GRANT SELECT ON public.susdr_vaults TO anon;
GRANT SELECT ON public.susdr_vaults TO authenticated;
GRANT ALL ON public.susdr_vaults TO service_role;
ALTER TABLE public.susdr_vaults ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read susdr vaults"
  ON public.susdr_vaults FOR SELECT TO anon, authenticated
  USING (true);

CREATE POLICY "Admins manage susdr vaults"
  ON public.susdr_vaults FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE TRIGGER set_susdr_vaults_updated_at
  BEFORE UPDATE ON public.susdr_vaults
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Position watchlist — lets a signed-in user label which on-chain payment
-- key hash is theirs, purely so the UI can show "my positions" without
-- asking every visitor to reconnect a wallet just to browse. This grants NO
-- on-chain authority: redemption is still gated by the Position UTxO's own
-- owner signature on chain (susdr_vault.ak's Withdraw rule), never by a row
-- in this table — see DESIGN.md, "sUSDr is a proof-of-claim receipt, not a
-- bearer token". A user may only ever write their OWN watchlist row.
-- ---------------------------------------------------------------------------

CREATE TABLE public.susdr_position_watchlist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  owner_key_hash text NOT NULL,
  label text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, owner_key_hash),
  CONSTRAINT susdr_position_watchlist_key_hash_format CHECK (owner_key_hash ~ '^[0-9a-f]{56}$')
);

GRANT SELECT, INSERT, DELETE ON public.susdr_position_watchlist TO authenticated;
GRANT ALL ON public.susdr_position_watchlist TO service_role;
ALTER TABLE public.susdr_position_watchlist ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own watchlist"
  ON public.susdr_position_watchlist FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users add to own watchlist"
  ON public.susdr_position_watchlist FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users remove from own watchlist"
  ON public.susdr_position_watchlist FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Accrual cache — mirrors yield_accruals. Chain is the source of truth; this
-- exists for query speed (vault detail view's share-price/epoch/APY history)
-- so the UI is not forced to re-scan the whole chain on every page load.
-- ---------------------------------------------------------------------------

CREATE TABLE public.susdr_accruals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vault_id uuid NOT NULL REFERENCES public.susdr_vaults(id) ON DELETE CASCADE,
  network text NOT NULL DEFAULT 'preprod',
  tx_hash text NOT NULL,
  epoch integer NOT NULL,
  amount_usdr bigint NOT NULL,
  total_assets_after bigint NOT NULL,
  total_shares_after bigint NOT NULL,
  share_price_before numeric,
  share_price_after numeric,
  fee_shares_minted bigint NOT NULL DEFAULT 0,
  block_height bigint,
  block_time timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tx_hash, network)
);

GRANT SELECT ON public.susdr_accruals TO anon;
GRANT SELECT ON public.susdr_accruals TO authenticated;
GRANT ALL ON public.susdr_accruals TO service_role;
ALTER TABLE public.susdr_accruals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read susdr accruals"
  ON public.susdr_accruals FOR SELECT TO anon, authenticated
  USING (true);

CREATE POLICY "Operators record susdr accruals"
  ON public.susdr_accruals FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'operator'));

CREATE INDEX susdr_accruals_vault_epoch_idx
  ON public.susdr_accruals (vault_id, epoch DESC);
