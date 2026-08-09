CREATE OR REPLACE FUNCTION public.execute_fund_asset_proposal(_proposal_id uuid, _user_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  p public.governance_proposals%ROWTYPE;
  fr public.funding_requests%ROWTYPE;
  slug text;
BEGIN
  IF NOT public.has_role(_user_id, 'admin') THEN
    RAISE EXCEPTION 'This action requires the admin role.';
  END IF;

  SELECT * INTO p FROM public.governance_proposals WHERE id = _proposal_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Proposal not found.'; END IF;
  IF p.kind <> 'fund_asset' THEN RAISE EXCEPTION 'That proposal does not create an asset.'; END IF;
  IF p.status <> 'passed' THEN RAISE EXCEPTION 'Only a proposal that has passed can be executed.'; END IF;

  SELECT * INTO fr FROM public.funding_requests
   WHERE id = (p.params->>'funding_request_id')::uuid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'The funding request behind this proposal no longer exists.'; END IF;

  slug := fr.asset_slug;
  IF EXISTS (SELECT 1 FROM public.assets WHERE id = slug) THEN
    RAISE EXCEPTION 'An asset with the id % already exists.', slug;
  END IF;

  INSERT INTO public.assets (
    id, name, category, issuer, location, description,
    target_lovelace, raised_lovelace, min_deposit_lovelace,
    maturity_months, funding_status, data_source
  ) VALUES (
    slug, fr.name, fr.category, fr.issuer, fr.location, fr.description,
    fr.target_lovelace, 0, fr.min_deposit_lovelace,
    fr.maturity_months, 'open', 'live'
  );

  UPDATE public.funding_requests
     SET status = 'asset_created', asset_id = slug
   WHERE id = fr.id;

  UPDATE public.governance_proposals
     SET status = 'executed', executed_at = now(),
         executed_tx_hash = NULL, executed_epoch = NULL
   WHERE id = p.id;

  RETURN slug;
END;
$$;

REVOKE ALL ON FUNCTION public.execute_fund_asset_proposal(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.execute_fund_asset_proposal(uuid, uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.mark_proposal_executed_offchain(_proposal_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.governance_proposals
     SET status = 'executed', executed_at = now(),
         executed_tx_hash = NULL, executed_epoch = NULL
   WHERE id = _proposal_id AND status = 'passed';
$$;

REVOKE ALL ON FUNCTION public.mark_proposal_executed_offchain(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mark_proposal_executed_offchain(uuid) TO authenticated, service_role;