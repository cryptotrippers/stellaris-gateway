-- Governance pipeline fix, part 1: RLS.
--
-- governance_proposals had no INSERT policy for a plain authenticated user —
-- only "Admins manage proposals" (admin-only) and "Operators record proposal
-- execution" (UPDATE-only, operator). createVaultProposal() inserts through
-- the caller's own RLS-scoped client, so any submitter who wasn't an admin
-- was silently rejected by Postgres, contradicting the documented design
-- ("the submitter or an admin can propose this request for a vote").
--
-- Mirrors the exact ownership pattern already used for funding_requests
-- ("Users submit own funding requests") and proposal_votes ("Users insert
-- own vote"): a signed-in user may only insert a proposal they author.

CREATE POLICY "Users create own proposals"
  ON public.governance_proposals FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = author_user_id);
