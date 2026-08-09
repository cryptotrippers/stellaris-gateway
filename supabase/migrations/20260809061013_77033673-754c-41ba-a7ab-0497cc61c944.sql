CREATE OR REPLACE FUNCTION public.mark_proposal_executed_offchain(_proposal_id uuid, _user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  p public.governance_proposals%ROWTYPE;
BEGIN
  IF NOT (public.has_role(_user_id, 'admin') OR public.has_role(_user_id, 'operator')) THEN
    RAISE EXCEPTION 'This action requires the operator role.';
  END IF;

  SELECT * INTO p FROM public.governance_proposals WHERE id = _proposal_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Proposal not found.'; END IF;
  IF p.status <> 'passed' THEN RAISE EXCEPTION 'Only a proposal that has passed can be executed.'; END IF;
  IF p.kind NOT IN ('set_fee', 'fund_asset') THEN
    RAISE EXCEPTION 'That proposal kind must be executed with an on-chain transaction.';
  END IF;

  UPDATE public.governance_proposals
     SET status = 'executed', executed_at = now(),
         executed_tx_hash = NULL, executed_epoch = NULL
   WHERE id = p.id;
END;
$$;

DROP FUNCTION IF EXISTS public.mark_proposal_executed_offchain(uuid);

REVOKE ALL ON FUNCTION public.mark_proposal_executed_offchain(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mark_proposal_executed_offchain(uuid, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.mark_proposal_executed_offchain(uuid, uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.execute_fund_asset_proposal(uuid, uuid) FROM anon;