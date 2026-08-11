-- Onboarding: record which platform terms version a funding request's
-- submitter accepted, and when. Server-validated in
-- submitFundingRequest(); this constraint is defense in depth so a row
-- can never reach a non-draft status without it.

ALTER TABLE public.funding_requests
  ADD COLUMN terms_version text,
  ADD COLUMN terms_accepted_at timestamptz;

ALTER TABLE public.funding_requests
  ADD CONSTRAINT funding_requests_terms_required_unless_draft
  CHECK (status = 'draft' OR (terms_version IS NOT NULL AND terms_accepted_at IS NOT NULL));
