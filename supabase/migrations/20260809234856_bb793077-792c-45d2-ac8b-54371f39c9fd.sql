ALTER TABLE public.asset_vaults
  ADD COLUMN ref_script_utxos jsonb NOT NULL DEFAULT '{}'::jsonb;