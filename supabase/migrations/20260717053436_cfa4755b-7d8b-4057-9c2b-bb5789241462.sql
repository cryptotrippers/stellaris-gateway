
-- Enums
CREATE TYPE public.kyc_status AS ENUM ('unverified', 'pending', 'verified', 'rejected');
CREATE TYPE public.transaction_type AS ENUM ('deposit', 'withdraw', 'yield');
CREATE TYPE public.proposal_status AS ENUM ('draft', 'active', 'passed', 'rejected', 'executed');

-- user_profiles
CREATE TABLE public.user_profiles (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  wallet_address TEXT,
  kyc_status public.kyc_status NOT NULL DEFAULT 'unverified',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_profiles TO authenticated;
GRANT ALL ON public.user_profiles TO service_role;
ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read own profile" ON public.user_profiles FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users insert own profile" ON public.user_profiles FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users update own profile" ON public.user_profiles FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- vault_positions
CREATE TABLE public.vault_positions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  vault_id TEXT NOT NULL,
  amount_ada NUMERIC(20,6) NOT NULL,
  tx_hash TEXT NOT NULL,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX vault_positions_user_idx ON public.vault_positions(user_id);
CREATE INDEX vault_positions_vault_idx ON public.vault_positions(vault_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.vault_positions TO authenticated;
GRANT ALL ON public.vault_positions TO service_role;
ALTER TABLE public.vault_positions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own positions" ON public.vault_positions FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- transactions
CREATE TABLE public.transactions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  vault_id TEXT NOT NULL,
  type public.transaction_type NOT NULL,
  amount_ada NUMERIC(20,6) NOT NULL,
  tx_hash TEXT NOT NULL,
  block_height BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX transactions_user_idx ON public.transactions(user_id);
CREATE INDEX transactions_vault_idx ON public.transactions(vault_id);
GRANT SELECT, INSERT ON public.transactions TO authenticated;
GRANT ALL ON public.transactions TO service_role;
ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read own transactions" ON public.transactions FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users insert own transactions" ON public.transactions FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

-- security_sessions
CREATE TABLE public.security_sessions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  device TEXT,
  browser TEXT,
  location TEXT,
  last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX security_sessions_user_idx ON public.security_sessions(user_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.security_sessions TO authenticated;
GRANT ALL ON public.security_sessions TO service_role;
ALTER TABLE public.security_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own sessions" ON public.security_sessions FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- security_audit_log (user-read-own; writes via service_role only)
CREATE TABLE public.security_audit_log (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  detail JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX security_audit_log_user_idx ON public.security_audit_log(user_id);
GRANT SELECT ON public.security_audit_log TO authenticated;
GRANT ALL ON public.security_audit_log TO service_role;
ALTER TABLE public.security_audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read own audit log" ON public.security_audit_log FOR SELECT TO authenticated USING (auth.uid() = user_id);

-- governance_proposals (public read)
CREATE TABLE public.governance_proposals (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  sip_number TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  status public.proposal_status NOT NULL DEFAULT 'active',
  votes_for_pct NUMERIC(5,2) NOT NULL DEFAULT 0,
  ends_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT ON public.governance_proposals TO anon, authenticated;
GRANT ALL ON public.governance_proposals TO service_role;
ALTER TABLE public.governance_proposals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can read proposals" ON public.governance_proposals FOR SELECT TO anon, authenticated USING (true);

-- updated_at trigger
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

CREATE TRIGGER user_profiles_updated_at BEFORE UPDATE ON public.user_profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER governance_proposals_updated_at BEFORE UPDATE ON public.governance_proposals
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Auto-create profile on user signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.user_profiles (user_id) VALUES (NEW.id) ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END; $$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
