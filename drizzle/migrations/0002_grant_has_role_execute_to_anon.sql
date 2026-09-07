-- has_role is SECURITY DEFINER and only reads public.user_roles; granting
-- EXECUTE to anon lets public SELECT policies (impact_attestations,
-- impact_metrics, etc.) evaluate without "permission denied for function".
GRANT EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) TO anon;