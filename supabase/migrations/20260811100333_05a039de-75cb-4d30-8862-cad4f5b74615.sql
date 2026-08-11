DROP POLICY IF EXISTS "Signed-in users can read admin wallets" ON public.admin_wallets;
CREATE POLICY "Admins can read admin wallets"
  ON public.admin_wallets FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role));
REVOKE SELECT ON public.admin_wallets FROM anon;

DROP POLICY IF EXISTS "Anyone can read votes" ON public.proposal_votes;
CREATE POLICY "Voters read own votes"
  ON public.proposal_votes FOR SELECT TO authenticated
  USING (auth.uid() = voter_user_id OR public.has_role(auth.uid(), 'admin'::app_role));
REVOKE SELECT ON public.proposal_votes FROM anon;

REVOKE ALL ON FUNCTION public.execute_fund_asset_proposal(uuid, uuid) FROM authenticated, anon, PUBLIC;
REVOKE ALL ON FUNCTION public.mark_proposal_executed_offchain(uuid, uuid) FROM authenticated, anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.execute_fund_asset_proposal(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_proposal_executed_offchain(uuid, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role app_role)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NOT NULL AND _user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'has_role may only be called for the current user.';
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role
  );
END;
$$;