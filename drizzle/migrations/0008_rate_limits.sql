-- Security Suite S3.2: fixed-window rate limits shared by every server
-- instance. Keys are "<bucket>:<hash of user id or IP>"; no raw IPs stored.
-- Only the server (service role) can call hit_rate_limit; the table has RLS
-- on and no policies, so no client can read or write it.

CREATE TABLE IF NOT EXISTS public.rate_limit_hits (
  key text NOT NULL CHECK (char_length(key) <= 96),
  window_start timestamptz NOT NULL,
  hits integer NOT NULL DEFAULT 0,
  PRIMARY KEY (key, window_start)
);

ALTER TABLE public.rate_limit_hits ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS rate_limit_hits_window_idx ON public.rate_limit_hits (window_start);

-- Returns true when the call is allowed (and counts it), false when over the limit.
CREATE OR REPLACE FUNCTION public.hit_rate_limit(p_key text, p_window_seconds integer, p_max integer)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  w timestamptz;
  n integer;
BEGIN
  IF p_key IS NULL OR char_length(p_key) > 96 OR p_window_seconds < 1 OR p_max < 1 THEN
    RETURN false;
  END IF;
  w := to_timestamp(floor(extract(epoch FROM now()) / p_window_seconds) * p_window_seconds);

  INSERT INTO public.rate_limit_hits (key, window_start, hits)
  VALUES (left(p_key, 96), w, 1)
  ON CONFLICT (key, window_start)
  DO UPDATE SET hits = public.rate_limit_hits.hits + 1
  RETURNING hits INTO n;

  -- Opportunistic clean-up of windows older than a day.
  IF random() < 0.01 THEN
    DELETE FROM public.rate_limit_hits WHERE window_start < now() - interval '1 day';
  END IF;

  RETURN n <= p_max;
END;
$$;

REVOKE ALL ON FUNCTION public.hit_rate_limit(text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hit_rate_limit(text, integer, integer) TO service_role;
