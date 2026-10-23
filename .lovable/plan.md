# Security fixes from the 23 Oct review

One new migration plus the code changes below. No other policy is touched.

## What I found first

- **vault_positions:** nothing in the app writes this table from the browser today (only reads: `routes/app.tsx`, `hooks/useGovernanceData.ts`, and server-side sums in governance functions). The forgery risk is the `ALL` policy itself, which lets any signed-in user insert rows directly through the API. Dropping it closes the hole. I will add one verified server write path so positions can still be recorded legitimately.
- **transactions / security_audit_log:** written by `recordVaultTransaction` and `logSecurityEvent` using the user's own client, so both rely on the INSERT policies being removed. The database triggers that log into `security_audit_log` are security definer and keep working.
- **issuers:** private columns are read by `accelerator.functions.ts` (pipeline, project toolkit, issuer page, save/verify returns), `issuer-workspace.query.ts` (browser) and shown on `issuers.$id.tsx` and `ProjectToolkit.tsx`.
- **funding_requests:** public lists use the publishable client, so drafts will simply disappear from them for other people. That is the intended effect.

## Migration SQL

```sql
-- 1. vault_positions: read own only, no user writes
DROP POLICY "Users manage own positions" ON public.vault_positions;
CREATE POLICY "Users read own positions" ON public.vault_positions
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
REVOKE INSERT, UPDATE, DELETE ON public.vault_positions FROM authenticated, anon;
GRANT ALL ON public.vault_positions TO service_role;

-- 2. funding_requests: hide other people's drafts
DROP POLICY "Anyone can read funding requests" ON public.funding_requests;
CREATE POLICY "Read non-draft, own or admin funding requests" ON public.funding_requests
  FOR SELECT TO anon, authenticated
  USING (status <> 'draft' OR auth.uid() = submitted_by OR public.has_role(auth.uid(), 'admin'));

-- 3. issuers: column-level read, private columns via server only
REVOKE SELECT ON public.issuers FROM anon, authenticated;
GRANT SELECT (id, legal_name, jurisdiction, website, wrapper_type,
              verification_status, verified_at, created_at)
  ON public.issuers TO anon, authenticated;
GRANT ALL ON public.issuers TO service_role;
-- policies on issuers unchanged; INSERT/UPDATE grants unchanged

-- 4. impact_attestations: only admins set/change published
CREATE OR REPLACE FUNCTION public.guard_attestation_publish()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF (TG_OP = 'INSERT' AND NEW.published)
     OR (TG_OP = 'UPDATE' AND NEW.published IS DISTINCT FROM OLD.published) THEN
    IF NOT public.has_role(auth.uid(), 'admin') THEN
      RAISE EXCEPTION 'Only an admin can publish or unpublish an impact attestation.';
    END IF;
    INSERT INTO public.security_audit_log (user_id, action, detail)
    VALUES (auth.uid(), 'impact_attestation_publish_changed',
            jsonb_build_object('attestation_id', NEW.id, 'published', NEW.published));
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER trg_guard_attestation_publish
  BEFORE INSERT OR UPDATE ON public.impact_attestations
  FOR EACH ROW EXECUTE FUNCTION public.guard_attestation_publish();

-- 5. audit log + transactions: server-only writes
DROP POLICY "Users insert own audit log" ON public.security_audit_log;
DROP POLICY "Users insert own transactions" ON public.transactions;
REVOKE INSERT ON public.security_audit_log FROM authenticated, anon;
REVOKE INSERT ON public.transactions FROM authenticated, anon;
GRANT ALL ON public.security_audit_log, public.transactions TO service_role;
```

Note: like the checklist trigger, the publish guard also blocks server code running without a signed-in admin. Today nothing publishes from server code, so this matches your "same style" request.

## Code changes

1. **New `src/lib/vault-positions.functions.ts`** — `recordVaultPosition` (signed-in): fetches the tx from Blockfrost, confirms it pays the claimed amount to a registered vault script address, and checks the user's linked wallet is a signer or input owner. Only then does it upsert with the server client. Same pattern as `recordFractionEvent`.
2. **`vault-transactions.functions.ts`** — after auth, confirm the tx exists on Blockfrost and touches a registered vault address, then insert with the server client (loaded inside the handler).
3. **`security.functions.ts`** — insert with the server client, `user_id` always taken from the verified session.
4. **Issuers**
   - `accelerator.functions.ts`: public reads use public columns only (`IssuerRow` makes the two private fields optional). Save/verify return public columns. New `getIssuerPrivate({ issuerId })`: owner (checked server-side) or admin gets `contact_email` and `registration_number` through the server client.
   - `issuer-workspace.query.ts`: browser query drops `registration_number`; the workspace gets private fields from `getIssuerPrivate`.
   - `issuers.$id.tsx` and `ProjectToolkit.tsx`: show registration only when `getIssuerPrivate` returns it, otherwise hide that line.
   - Issuer edit form pre-fills the private fields from `getIssuerPrivate`.
5. **Types:** regenerate after the migration.

## Verification

- After the migration, list every policy on every public table (`pg_policies`) and paste it here.
- As a disposable test user, using the browser client: insert into `vault_positions`, `transactions` and `security_audit_log` fails; selecting `contact_email` from `issuers` fails; another user's draft funding request is invisible; setting `published = true` on your own attestation fails, while editing other fields succeeds.
- Typecheck, existing tests, and a page check of the pipeline, issuer page, issuer dashboard and security page. The test user is removed afterwards.
- Nothing published.
