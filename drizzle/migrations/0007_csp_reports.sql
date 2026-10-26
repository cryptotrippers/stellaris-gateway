-- Security Suite S2.1: record Content Security Policy violation reports so the
-- policy can be tightened from report-only to enforcing.
--
-- Only sanitised fields are stored (directive, blocked origin, page path,
-- disposition): no full URLs, query strings, code samples or IP addresses.
-- Rows are aggregated per day; at most 2,000 distinct rows a day are created,
-- after which only existing rows' counters move.

CREATE TABLE IF NOT EXISTS public.csp_reports (
  id bigserial PRIMARY KEY,
  day date NOT NULL DEFAULT ((now() AT TIME ZONE 'utc')::date),
  directive text NOT NULL CHECK (char_length(directive) <= 64),
  blocked text NOT NULL CHECK (char_length(blocked) <= 200),
  document_path text NOT NULL CHECK (char_length(document_path) <= 200),
  disposition text NOT NULL CHECK (disposition IN ('enforce', 'report')),
  hits integer NOT NULL DEFAULT 1,
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen timestamptz NOT NULL DEFAULT now(),
  UNIQUE (day, directive, blocked, document_path, disposition)
);

ALTER TABLE public.csp_reports ENABLE ROW LEVEL SECURITY;

-- No INSERT/UPDATE/DELETE policies: browsers and users never write here.
DROP POLICY IF EXISTS "Admins read csp reports" ON public.csp_reports;
CREATE POLICY "Admins read csp reports"
  ON public.csp_reports
  FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE OR REPLACE FUNCTION public.record_csp_report(
  p_directive text,
  p_blocked text,
  p_document_path text,
  p_disposition text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  today date := (now() AT TIME ZONE 'utc')::date;
  d text := left(coalesce(p_directive, 'unknown'), 64);
  b text := left(coalesce(p_blocked, 'other'), 200);
  p text := left(coalesce(p_document_path, '/'), 200);
  disp text := CASE WHEN p_disposition = 'enforce' THEN 'enforce' ELSE 'report' END;
BEGIN
  IF (SELECT count(*) FROM public.csp_reports WHERE day = today) >= 2000 THEN
    UPDATE public.csp_reports
       SET hits = hits + 1, last_seen = now()
     WHERE day = today AND directive = d AND blocked = b AND document_path = p AND disposition = disp;
    RETURN;
  END IF;

  INSERT INTO public.csp_reports (day, directive, blocked, document_path, disposition)
  VALUES (today, d, b, p, disp)
  ON CONFLICT (day, directive, blocked, document_path, disposition)
  DO UPDATE SET hits = public.csp_reports.hits + 1, last_seen = now();
END;
$$;

REVOKE ALL ON FUNCTION public.record_csp_report(text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_csp_report(text, text, text, text) TO service_role;
