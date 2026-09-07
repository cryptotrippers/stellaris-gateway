-- Anon queries against impact_attestations/impact_metrics failed with
-- "permission denied for function has_role" because their SELECT policies
-- call has_role(), whose EXECUTE is revoked from anon. Short-circuit the
-- policies so the privileged branch is only evaluated for signed-in users;
-- has_role stays locked to authenticated/service_role.

DROP POLICY IF EXISTS "Published attestations are public" ON public.impact_attestations;
CREATE POLICY "Published attestations are public"
  ON public.impact_attestations
  FOR SELECT
  USING (
    published
    OR (auth.uid() IS NOT NULL AND auth.uid() = created_by)
    OR (auth.uid() IS NOT NULL AND public.has_role(auth.uid(), 'admin'))
  );

DROP POLICY IF EXISTS "Metrics follow their attestation" ON public.impact_metrics;
CREATE POLICY "Metrics follow their attestation"
  ON public.impact_metrics
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.impact_attestations ia
      WHERE ia.id = attestation_id AND ia.published
    )
    OR (auth.uid() IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.impact_attestations ia
      WHERE ia.id = attestation_id AND ia.created_by = auth.uid()
    ))
    OR (auth.uid() IS NOT NULL AND public.has_role(auth.uid(), 'admin'))
  );