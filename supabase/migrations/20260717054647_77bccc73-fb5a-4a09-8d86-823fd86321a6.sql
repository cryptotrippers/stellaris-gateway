
CREATE TABLE public.user_security_settings (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL UNIQUE,
  mfa BOOLEAN NOT NULL DEFAULT false,
  hardware_wallet BOOLEAN NOT NULL DEFAULT false,
  withdrawal_whitelist BOOLEAN NOT NULL DEFAULT false,
  timelock_24h BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON public.user_security_settings TO authenticated;
GRANT ALL ON public.user_security_settings TO service_role;

ALTER TABLE public.user_security_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own security settings" ON public.user_security_settings
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users insert own security settings" ON public.user_security_settings
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users update own security settings" ON public.user_security_settings
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER trg_user_security_settings_updated_at
  BEFORE UPDATE ON public.user_security_settings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Auto-create a settings row when a new auth user is created
CREATE OR REPLACE FUNCTION public.handle_new_user_security_settings()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.user_security_settings (user_id) VALUES (NEW.id)
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.handle_new_user_security_settings() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS on_auth_user_created_security_settings ON auth.users;
CREATE TRIGGER on_auth_user_created_security_settings
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user_security_settings();

-- Audit-log trigger: whenever security settings change, record which toggle flipped
CREATE OR REPLACE FUNCTION public.log_security_setting_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  changed JSONB := '{}'::jsonb;
BEGIN
  IF NEW.mfa IS DISTINCT FROM OLD.mfa THEN
    changed := changed || jsonb_build_object('setting','mfa','value',NEW.mfa);
  END IF;
  IF NEW.hardware_wallet IS DISTINCT FROM OLD.hardware_wallet THEN
    changed := changed || jsonb_build_object('setting','hardware_wallet','value',NEW.hardware_wallet);
  END IF;
  IF NEW.withdrawal_whitelist IS DISTINCT FROM OLD.withdrawal_whitelist THEN
    changed := changed || jsonb_build_object('setting','withdrawal_whitelist','value',NEW.withdrawal_whitelist);
  END IF;
  IF NEW.timelock_24h IS DISTINCT FROM OLD.timelock_24h THEN
    changed := changed || jsonb_build_object('setting','timelock_24h','value',NEW.timelock_24h);
  END IF;

  IF changed <> '{}'::jsonb THEN
    INSERT INTO public.security_audit_log (user_id, action, detail)
    VALUES (NEW.user_id, 'security_setting_changed', changed);
  END IF;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.log_security_setting_change() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER trg_log_security_setting_change
  AFTER UPDATE ON public.user_security_settings
  FOR EACH ROW EXECUTE FUNCTION public.log_security_setting_change();

-- Backfill for existing users
INSERT INTO public.user_security_settings (user_id)
SELECT id FROM auth.users
ON CONFLICT (user_id) DO NOTHING;

-- Allow authenticated users to insert their own audit log rows (for login/tx events written via server fn as the user)
CREATE POLICY "Users insert own audit log" ON public.security_audit_log
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
