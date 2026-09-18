-- Fractional-ownership hub: the offering registry and the verified on-chain
-- event log behind it. Both are public read; writes are admin/server only.

CREATE TABLE public.offerings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id TEXT NOT NULL REFERENCES public.assets(id),
  network TEXT NOT NULL DEFAULT 'preprod',
  vault_version INTEGER NOT NULL DEFAULT 1,
  script_hash TEXT NOT NULL,
  script_address TEXT NOT NULL,
  fraction_policy_id TEXT NOT NULL,
  fraction_asset_name_hex TEXT NOT NULL,
  deposit_asset_id UUID REFERENCES public.deposit_assets(id),
  total_fractions BIGINT NOT NULL CHECK (total_fractions > 0),
  price_per_fraction BIGINT NOT NULL CHECK (price_per_fraction > 0),
  mint_fee_bps INTEGER NOT NULL DEFAULT 0 CHECK (mint_fee_bps BETWEEN 0 AND 500),
  redeem_fee_bps INTEGER NOT NULL DEFAULT 0 CHECK (redeem_fee_bps BETWEEN 0 AND 500),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','redeeming')),
  issuer_name TEXT NOT NULL,
  treasury_address TEXT,
  operator_key_hashes TEXT[] NOT NULL DEFAULT '{}',
  signature_threshold INTEGER NOT NULL DEFAULT 1 CHECK (signature_threshold > 0),
  bootstrap_tx_hash TEXT,
  bootstrapped_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (asset_id, vault_version, network)
);

GRANT SELECT ON public.offerings TO anon;
GRANT SELECT ON public.offerings TO authenticated;
GRANT ALL ON public.offerings TO service_role;

ALTER TABLE public.offerings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Offerings are public" ON public.offerings
  FOR SELECT USING (true);

CREATE POLICY "Admins manage offerings" ON public.offerings
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE TRIGGER set_offerings_updated_at
  BEFORE UPDATE ON public.offerings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Verified chain events. A row is only written server-side once Blockfrost
-- confirms the transaction, so this table is evidence, not intent.
CREATE TABLE public.fraction_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  offering_id UUID NOT NULL REFERENCES public.offerings(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES public.assets(id),
  event_type TEXT NOT NULL CHECK (event_type IN ('bootstrap','buy','redeem','distribute','set_status','set_fees','claim_fee')),
  tx_hash TEXT NOT NULL,
  fractions BIGINT NOT NULL DEFAULT 0,
  amount BIGINT NOT NULL DEFAULT 0,
  fee_amount BIGINT NOT NULL DEFAULT 0,
  counterparty_address TEXT,
  network TEXT NOT NULL DEFAULT 'preprod',
  slot BIGINT,
  block_time TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tx_hash, event_type, offering_id)
);

CREATE INDEX fraction_events_offering_idx ON public.fraction_events (offering_id, created_at DESC);

GRANT SELECT ON public.fraction_events TO anon;
GRANT SELECT ON public.fraction_events TO authenticated;
GRANT ALL ON public.fraction_events TO service_role;

ALTER TABLE public.fraction_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Fraction events are public" ON public.fraction_events
  FOR SELECT USING (true);

CREATE POLICY "Admins record fraction events" ON public.fraction_events
  FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'admin'));
