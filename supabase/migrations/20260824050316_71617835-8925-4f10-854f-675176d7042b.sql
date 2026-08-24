CREATE TABLE public.deposit_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol text NOT NULL,
  display_name text NOT NULL,
  policy_id text NOT NULL DEFAULT '',
  asset_name_hex text NOT NULL DEFAULT '',
  decimals integer NOT NULL DEFAULT 6,
  network text NOT NULL DEFAULT 'preprod',
  status text NOT NULL DEFAULT 'planned',
  issuer_name text NOT NULL,
  docs_url text,
  cip113_metadata_url text,
  sort_order integer NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT deposit_assets_network_chk CHECK (network IN ('preprod','mainnet')),
  CONSTRAINT deposit_assets_status_chk CHECK (status IN ('live','test','planned')),
  CONSTRAINT deposit_assets_decimals_chk CHECK (decimals >= 0 AND decimals <= 18),
  CONSTRAINT deposit_assets_policy_chk CHECK (policy_id = '' OR policy_id ~ '^[0-9a-f]{56}$'),
  CONSTRAINT deposit_assets_name_chk CHECK (asset_name_hex = '' OR asset_name_hex ~ '^[0-9a-f]{2,64}$'),
  CONSTRAINT deposit_assets_symbol_uniq UNIQUE (network, symbol)
);

GRANT SELECT ON public.deposit_assets TO anon;
GRANT SELECT ON public.deposit_assets TO authenticated;
GRANT ALL ON public.deposit_assets TO service_role;

ALTER TABLE public.deposit_assets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Deposit asset registry is public"
  ON public.deposit_assets FOR SELECT
  USING (true);

CREATE POLICY "Admins can insert deposit assets"
  ON public.deposit_assets FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can update deposit assets"
  ON public.deposit_assets FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can delete deposit assets"
  ON public.deposit_assets FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE TRIGGER set_deposit_assets_updated_at
  BEFORE UPDATE ON public.deposit_assets
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

INSERT INTO public.deposit_assets
  (symbol, display_name, policy_id, asset_name_hex, decimals, network, status, issuer_name, docs_url, sort_order)
VALUES
  ('ADA', 'Cardano (test ADA)', '', '', 6, 'preprod', 'live', 'Cardano protocol', 'https://docs.cardano.org', 10),
  ('USDr', 'USDr (Preprod test stand-in)', '', '', 6, 'preprod', 'test', 'Stellaris test issuer', null, 20),
  ('USDM', 'USDM', 'c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad', '0014df105553444d', 6, 'mainnet', 'planned', 'Moneta / Mehen', 'https://mehen.io', 30),
  ('iUSD', 'iUSD', 'f66d78b4a3cb3d37afa0ec36461e51ecbde00f26c8f0a68f94b69880', '69555344', 6, 'mainnet', 'planned', 'Indigo Protocol', 'https://indigoprotocol.io', 40);