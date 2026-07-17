
-- Real asset catalogue (replaces src/lib/mock-data.ts ASSETS)
CREATE TABLE public.assets (
  id text PRIMARY KEY,
  name text NOT NULL,
  category text NOT NULL,
  issuer text NOT NULL,
  location text,
  description text,
  target_lovelace bigint NOT NULL DEFAULT 0,
  raised_lovelace bigint NOT NULL DEFAULT 0,
  min_deposit_lovelace bigint NOT NULL DEFAULT 10000000,
  maturity_months integer,
  funding_status text NOT NULL DEFAULT 'draft', -- draft | open | funded | matured | cancelled
  audit_report_url text,
  oracle_feed_id uuid,
  data_source text NOT NULL DEFAULT 'preview', -- preview | live
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.assets TO anon, authenticated;
GRANT ALL ON public.assets TO service_role;
ALTER TABLE public.assets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read assets" ON public.assets
  FOR SELECT TO anon, authenticated USING (true);

CREATE TRIGGER set_assets_updated_at BEFORE UPDATE ON public.assets
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Contract audit registry. Rows exist only when a real audit report has been published.
CREATE TABLE public.contract_audits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_name text NOT NULL,
  auditor text NOT NULL,
  report_url text NOT NULL,
  commit_hash text NOT NULL,
  blueprint_hash text,
  audited_at date NOT NULL,
  network text NOT NULL DEFAULT 'preprod', -- preprod | mainnet
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.contract_audits TO anon, authenticated;
GRANT ALL ON public.contract_audits TO service_role;
ALTER TABLE public.contract_audits ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read audits" ON public.contract_audits
  FOR SELECT TO anon, authenticated USING (true);

CREATE TRIGGER set_contract_audits_updated_at BEFORE UPDATE ON public.contract_audits
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Oracle feed registry (Charli3 / Orcfax). Populated only when a real feed is wired.
CREATE TABLE public.oracle_feeds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL, -- charli3 | orcfax
  pair text NOT NULL,     -- e.g. ADA/USD
  feed_address text NOT NULL,
  network text NOT NULL DEFAULT 'preprod',
  last_price numeric,
  last_observed_at timestamptz,
  last_tx_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.oracle_feeds TO anon, authenticated;
GRANT ALL ON public.oracle_feeds TO service_role;
ALTER TABLE public.oracle_feeds ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read oracle feeds" ON public.oracle_feeds
  FOR SELECT TO anon, authenticated USING (true);

CREATE TRIGGER set_oracle_feeds_updated_at BEFORE UPDATE ON public.oracle_feeds
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.assets
  ADD CONSTRAINT assets_oracle_feed_fk
  FOREIGN KEY (oracle_feed_id) REFERENCES public.oracle_feeds(id) ON DELETE SET NULL;

-- Public treasury / buyback registry. Address is null until a real multisig is deployed.
CREATE TABLE public.treasury_config (
  id integer PRIMARY KEY DEFAULT 1,
  treasury_address text,
  buyback_pct_bps integer NOT NULL DEFAULT 0,
  active_since_slot bigint,
  network text NOT NULL DEFAULT 'preprod',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT treasury_config_singleton CHECK (id = 1)
);

GRANT SELECT ON public.treasury_config TO anon, authenticated;
GRANT ALL ON public.treasury_config TO service_role;
ALTER TABLE public.treasury_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read treasury config" ON public.treasury_config
  FOR SELECT TO anon, authenticated USING (true);

CREATE TRIGGER set_treasury_config_updated_at BEFORE UPDATE ON public.treasury_config
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

INSERT INTO public.treasury_config (id, treasury_address, buyback_pct_bps, network)
VALUES (1, NULL, 0, 'preprod');

CREATE TABLE public.treasury_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL, -- fee_collected | buyback_executed
  tx_hash text NOT NULL,
  amount_lovelace bigint NOT NULL,
  slot bigint NOT NULL,
  block_time timestamptz NOT NULL,
  network text NOT NULL DEFAULT 'preprod',
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.treasury_events TO anon, authenticated;
GRANT ALL ON public.treasury_events TO service_role;
ALTER TABLE public.treasury_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read treasury events" ON public.treasury_events
  FOR SELECT TO anon, authenticated USING (true);

CREATE UNIQUE INDEX treasury_events_tx_hash_idx ON public.treasury_events(tx_hash);

-- ZK-KYC attestations (Midnight integration point). Empty until a real proof is verified.
CREATE TABLE public.kyc_attestations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  subject_stake_address text,
  attestation_type text NOT NULL, -- accredited | sanctions_clear | jurisdiction_ok
  proof_cid text NOT NULL,
  verifier text NOT NULL,         -- midnight | manual
  verified_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT ON public.kyc_attestations TO authenticated;
GRANT ALL ON public.kyc_attestations TO service_role;
ALTER TABLE public.kyc_attestations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read their own attestations" ON public.kyc_attestations
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
