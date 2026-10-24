DROP POLICY "Users manage own positions" ON public.vault_positions;
CREATE POLICY "Users read own positions" ON public.vault_positions
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
REVOKE INSERT, UPDATE, DELETE ON public.vault_positions FROM authenticated, anon;
GRANT ALL ON public.vault_positions TO service_role;
ALTER TABLE public.vault_positions ADD CONSTRAINT vault_positions_tx_hash_key UNIQUE (tx_hash);
COMMENT ON TABLE public.vault_positions IS
  'History only. Voting weight is computed from unspent on-chain Position UTxOs.';

DROP POLICY "Anyone can read funding requests" ON public.funding_requests;
CREATE POLICY "Read non-draft, own or admin funding requests" ON public.funding_requests
  FOR SELECT TO anon, authenticated
  USING (status <> 'draft' OR auth.uid() = submitted_by OR public.has_role(auth.uid(), 'admin'));

REVOKE SELECT ON public.issuers FROM anon, authenticated;
GRANT SELECT (id, owner_user_id, legal_name, jurisdiction, website, wrapper_type,
              verification_status, verified_at, created_at)
  ON public.issuers TO anon, authenticated;
GRANT ALL ON public.issuers TO service_role;

CREATE OR REPLACE FUNCTION public.guard_attestation_publish()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF (TG_OP = 'INSERT' AND NEW.published)
     OR (TG_OP = 'UPDATE' AND NEW.published IS DISTINCT FROM OLD.published) THEN
    IF NOT public.has_role(auth.uid(), 'admin') THEN
      RAISE EXCEPTION 'Only an admin can publish or unpublish an impact attestation.';
    END IF;
    INSERT INTO public.security_audit_log (user_id, action, detail)
    VALUES (auth.uid(), 'impact_attestation_publish_changed',
            jsonb_build_object('attestation_id', NEW.id, 'published', NEW.published));
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER trg_guard_attestation_publish
  BEFORE INSERT OR UPDATE ON public.impact_attestations
  FOR EACH ROW EXECUTE FUNCTION public.guard_attestation_publish();

DROP POLICY "Users insert own audit log" ON public.security_audit_log;
DROP POLICY "Users insert own transactions" ON public.transactions;
REVOKE INSERT ON public.security_audit_log FROM authenticated, anon;
REVOKE INSERT ON public.transactions FROM authenticated, anon;
GRANT ALL ON public.security_audit_log, public.transactions TO service_role;
ALTER TABLE public.transactions ADD CONSTRAINT transactions_tx_hash_key UNIQUE (tx_hash);

CREATE TABLE public.wallet_link_nonces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  address text NOT NULL,
  nonce text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.wallet_link_nonces TO service_role;
ALTER TABLE public.wallet_link_nonces ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.linked_wallets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  address text NOT NULL,
  payment_key_hash text NOT NULL UNIQUE,
  network text NOT NULL DEFAULT 'preprod',
  signature text NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.linked_wallets TO authenticated;
GRANT ALL ON public.linked_wallets TO service_role;
ALTER TABLE public.linked_wallets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read own linked wallets" ON public.linked_wallets
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE INDEX linked_wallets_user_idx ON public.linked_wallets (user_id);