
INSERT INTO public.assets (
  id, name, category, issuer, location, description,
  target_lovelace, raised_lovelace, min_deposit_lovelace,
  maturity_months, funding_status, audit_report_url, data_source
) VALUES (
  'sfm-01',
  'Preprod Pilot Vault',
  'pilot',
  'Stellaris (self-issued, testnet)',
  'Cardano Preprod',
  'Phase-1 pilot vault used to exercise the on-chain deposit/withdraw flow against a compiled Aiken validator on Cardano Preprod. Not a real asset — Preprod tADA only. Owner PKH is enforced on withdraw.',
  0, 0, 2000000,
  NULL,
  'pilot',
  NULL,
  'onchain_preprod'
)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  category = EXCLUDED.category,
  issuer = EXCLUDED.issuer,
  location = EXCLUDED.location,
  description = EXCLUDED.description,
  min_deposit_lovelace = EXCLUDED.min_deposit_lovelace,
  funding_status = EXCLUDED.funding_status,
  data_source = EXCLUDED.data_source,
  updated_at = now();
