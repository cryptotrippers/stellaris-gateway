DO $$
DECLARE
  v_admin uuid;
BEGIN
  SELECT ur.user_id INTO v_admin
  FROM public.user_roles ur
  JOIN auth.users u ON u.id = ur.user_id
  WHERE ur.role = 'admin' AND u.email_confirmed_at IS NOT NULL
  LIMIT 1;

  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'Refusing to retire admin bootstrap: no email-verified admin exists yet.';
  END IF;

  DROP TRIGGER IF EXISTS on_auth_user_created_grant_admin ON auth.users;
  DROP TRIGGER IF EXISTS on_auth_user_confirmed_grant_admin ON auth.users;
  DROP FUNCTION IF EXISTS public.grant_admin_for_designated_email();

  INSERT INTO public.security_audit_log (user_id, action, detail)
  VALUES (
    v_admin,
    'admin_bootstrap_retired',
    jsonb_build_object(
      'removed_triggers', jsonb_build_array('on_auth_user_created_grant_admin','on_auth_user_confirmed_grant_admin'),
      'removed_function', 'public.grant_admin_for_designated_email()'
    )
  );
END $$;