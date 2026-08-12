ALTER TABLE public.funding_requests
  ADD COLUMN IF NOT EXISTS terms_version text,
  ADD COLUMN IF NOT EXISTS terms_accepted_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'funding_requests_terms_required_unless_draft'
  ) THEN
    ALTER TABLE public.funding_requests
      ADD CONSTRAINT funding_requests_terms_required_unless_draft
      CHECK (status = 'draft' OR (terms_version IS NOT NULL AND terms_accepted_at IS NOT NULL));
  END IF;
END $$;