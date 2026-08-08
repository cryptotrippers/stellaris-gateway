CREATE TYPE public.vote_choice AS ENUM ('for', 'against', 'abstain');

CREATE TABLE public.proposal_votes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id uuid NOT NULL REFERENCES public.governance_proposals(id) ON DELETE CASCADE,
  voter_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  choice public.vote_choice NOT NULL,
  weight_ada numeric NOT NULL DEFAULT 0,
  asset_id text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE (proposal_id, voter_user_id)
);

GRANT SELECT, INSERT, UPDATE ON public.proposal_votes TO authenticated;
GRANT SELECT ON public.proposal_votes TO anon;
GRANT ALL ON public.proposal_votes TO service_role;

ALTER TABLE public.proposal_votes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read votes"
  ON public.proposal_votes FOR SELECT
  TO anon, authenticated
  USING (true);

CREATE POLICY "Users insert own vote"
  ON public.proposal_votes FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = voter_user_id);

CREATE POLICY "Users update own vote"
  ON public.proposal_votes FOR UPDATE
  TO authenticated
  USING (auth.uid() = voter_user_id)
  WITH CHECK (auth.uid() = voter_user_id);

CREATE TRIGGER set_proposal_votes_updated_at
  BEFORE UPDATE ON public.proposal_votes
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE INDEX proposal_votes_proposal_idx ON public.proposal_votes(proposal_id);
