CREATE TABLE public.issuer_leads (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 contact_name text NOT NULL CHECK (char_length(contact_name) BETWEEN 1 AND 100),
 email text NOT NULL CHECK (char_length(email) <= 254),
 organization text NOT NULL CHECK (char_length(organization) BETWEEN 1 AND 160),
 jurisdiction text NOT NULL CHECK (char_length(jurisdiction) BETWEEN 1 AND 100),
 asset_category text NOT NULL CHECK (asset_category IN ('Clean energy','Agriculture','Property','Other')),
 project_summary text NOT NULL CHECK (char_length(project_summary) BETWEEN 20 AND 3000),
 consent_at timestamptz NOT NULL DEFAULT now(),
 status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','reviewing','contacted','qualified','closed')),
 internal_notes text NOT NULL DEFAULT '' CHECK (char_length(internal_notes) <= 5000)
);
GRANT SELECT, UPDATE ON public.issuer_leads TO authenticated;
GRANT ALL ON public.issuer_leads TO service_role;
ALTER TABLE public.issuer_leads ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins read issuer leads" ON public.issuer_leads FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role));
CREATE POLICY "Admins manage issuer leads" ON public.issuer_leads FOR UPDATE TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role)) WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));
CREATE INDEX issuer_leads_created_at_idx ON public.issuer_leads (created_at DESC);
COMMENT ON TABLE public.issuer_leads IS 'Private issuer enquiries; public submissions are validated and inserted server-side. Only administrators can read or update leads.';