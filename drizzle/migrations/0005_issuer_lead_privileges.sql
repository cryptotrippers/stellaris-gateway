REVOKE ALL ON public.issuer_leads FROM anon;
REVOKE INSERT, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.issuer_leads FROM authenticated;
GRANT SELECT, UPDATE ON public.issuer_leads TO authenticated;
GRANT ALL ON public.issuer_leads TO service_role;