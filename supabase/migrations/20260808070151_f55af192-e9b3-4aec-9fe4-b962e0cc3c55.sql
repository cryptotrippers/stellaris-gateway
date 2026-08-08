-- 1. Remove first-user-becomes-admin bootstrap
DROP TRIGGER IF EXISTS on_auth_user_created_bootstrap_admin ON auth.users;
DROP FUNCTION IF EXISTS public.bootstrap_first_admin();

-- 2. Grant admin only to the designated, email-verified account
CREATE OR REPLACE FUNCTION public.grant_admin_for_designated_email()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.email_confirmed_at IS NOT NULL
     AND lower(NEW.email) = 'cryptotrippers@gmail.com' THEN
    INSERT INTO public.user_roles (user_id, role)
    VALUES (NEW.id, 'admin')
    ON CONFLICT (user_id, role) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created_grant_admin ON auth.users;
CREATE TRIGGER on_auth_user_created_grant_admin
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.grant_admin_for_designated_email();

DROP TRIGGER IF EXISTS on_auth_user_confirmed_grant_admin ON auth.users;
CREATE TRIGGER on_auth_user_confirmed_grant_admin
AFTER UPDATE OF email_confirmed_at ON auth.users
FOR EACH ROW
WHEN (OLD.email_confirmed_at IS NULL AND NEW.email_confirmed_at IS NOT NULL)
EXECUTE FUNCTION public.grant_admin_for_designated_email();

-- Backfill: designated account may already exist and be verified
INSERT INTO public.user_roles (user_id, role)
SELECT id, 'admin'::app_role FROM auth.users
WHERE lower(email) = 'cryptotrippers@gmail.com' AND email_confirmed_at IS NOT NULL
ON CONFLICT (user_id, role) DO NOTHING;

-- Revoke admin from anyone who is not the designated account
DELETE FROM public.user_roles ur
WHERE ur.role = 'admin'
  AND ur.user_id NOT IN (
    SELECT id FROM auth.users WHERE lower(email) = 'cryptotrippers@gmail.com'
  );

-- 3. Master/admin wallet allow-list
CREATE TABLE public.admin_wallets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  address text NOT NULL UNIQUE,
  label text,
  network text NOT NULL DEFAULT 'preprod',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.admin_wallets TO authenticated;
GRANT ALL ON public.admin_wallets TO service_role;

ALTER TABLE public.admin_wallets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Signed-in users can read admin wallets"
ON public.admin_wallets FOR SELECT TO authenticated USING (true);

CREATE POLICY "Admins manage admin wallets"
ON public.admin_wallets FOR ALL TO authenticated
USING (public.has_role(auth.uid(), 'admin'::app_role))
WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role));

CREATE TRIGGER set_admin_wallets_updated_at
BEFORE UPDATE ON public.admin_wallets
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();