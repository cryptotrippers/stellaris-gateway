# Security fixes from the 23 Oct review (revised)

One new migration plus the code changes below. No policy outside this list is touched. Nothing is published.

## What I found

- **vault_positions:** nothing in the app writes this table from the browser. The risk is the `ALL` policy itself. Voting weight (`castVote`, `getMyVotingWeight`, `getEligibleWeights`, `finalizeProposal`) is currently a sum of recorded rows, which is the forgery path you described.
- **Wallet linking does not exist yet.** `user_profiles.wallet_address` is never written by the app, and there is no nonce or signature flow. I will add it (see below).
- **Signature checking:** `@lucid-evolution/sign_data` (already installed, includes `verifyData`) can verify CIP-30 `signData` on the server. No new package is needed.
- **Existing rows:** `vault_positions`, `transactions` and wallet columns are all empty (0 rows), so the unique constraints apply cleanly.
- **security_audit_log columns:** confirmed `user_id uuid NOT NULL`, `action text NOT NULL`, `detail jsonb` (nullable). The trigger uses exactly these. Because `user_id` is NOT NULL, the trigger only logs when `auth.uid()` is present, and the admin check already guarantees that.
- **issuers browser queries:** only `issuer-workspace.query.ts` reads issuers from the browser. It selects `registration_number` and filters on `owner_user_id`. No browser query filters on `contact_email` or `registration_number`. The private-column reads are moved server-side.

## Migration SQL

```sql
-- 1. vault_positions: read own only, no user writes, one record per tx
DROP POLICY "Users manage own positions" ON public.vault_positions;
CREATE POLICY "Users read own positions" ON public.vault_positions
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
REVOKE INSERT, UPDATE, DELETE ON public.vault_positions FROM authenticated, anon;
GRANT ALL ON public.vault_positions TO service_role;
ALTER TABLE public.vault_positions
  ADD CONSTRAINT vault_positions_tx_hash_key UNIQUE (tx_hash);
COMMENT ON TABLE public.vault_positions IS
  'History only. Voting weight is computed from unspent on-chain Position UTxOs.';

-- 2. funding_requests: hide other people's drafts
DROP POLICY "Anyone can read funding requests" ON public.funding_requests;
CREATE POLICY "Read non-draft, own or admin funding requests" ON public.funding_requests
  FOR SELECT TO anon, authenticated
  USING (status <> 'draft' OR auth.uid() = submitted_by OR public.has_role(auth.uid(), 'admin'));

-- 3. issuers: column-level read; private columns via server only
REVOKE SELECT ON public.issuers FROM anon, authenticated;
GRANT SELECT (id, owner_user_id, legal_name, jurisdiction, website, wrapper_type,
              verification_status, verified_at, created_at)
  ON public.issuers TO anon, authenticated;
GRANT ALL ON public.issuers TO service_role;

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

-- 5. audit log + transactions: server-only writes; one record per tx
DROP POLICY "Users insert own audit log" ON public.security_audit_log;
DROP POLICY "Users insert own transactions" ON public.transactions;
REVOKE INSERT ON public.security_audit_log FROM authenticated, anon;
REVOKE INSERT ON public.transactions FROM authenticated, anon;
GRANT ALL ON public.security_audit_log, public.transactions TO service_role;
ALTER TABLE public.transactions
  ADD CONSTRAINT transactions_tx_hash_key UNIQUE (tx_hash);

-- 6. Proven wallet links (new). Server-only writes.
CREATE TABLE public.wallet_link_nonces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  nonce text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.wallet_link_nonces TO service_role;
ALTER TABLE public.wallet_link_nonces ENABLE ROW LEVEL SECURITY;
-- no policies: only the server reads or writes nonces

CREATE TABLE public.linked_wallets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  address text NOT NULL,
  payment_key_hash text NOT NULL UNIQUE,  -- one wallet, one account
  network text NOT NULL DEFAULT 'preprod',
  signature text NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.linked_wallets TO authenticated;
GRANT ALL ON public.linked_wallets TO service_role;
ALTER TABLE public.linked_wallets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read own linked wallets" ON public.linked_wallets
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
```

The publish guard, like the checklist trigger, also blocks server code that runs without a signed-in admin. Nothing publishes from server code today.

## Code changes

1. **Wallet linking (new)** — `src/lib/wallet-link.functions.ts`
   - `requestWalletNonce` (signed in): stores a random nonce with a 10-minute expiry and returns the message to sign.
   - `confirmWalletLink` (signed in): receives the CIP-30 `signData` result (`signature`, `key`). The server loads the nonce from the database, checks it is the caller's, unused and not expired, verifies the signature with `verifyData` against the address embedded in the signed payload, and checks the key matches that address's payment key hash. Only then does it mark the nonce used and save the link with the server client. An address sent by the client is never trusted by itself.
   - A "Link this wallet" button on the security page and governance page uses the connected wallet's `signData`. The vote button explains when no wallet is linked.
2. **Recording positions** — `src/lib/vault-positions.functions.ts` `recordVaultPosition({ txHash })`: loads the tx from Blockfrost, finds the output at a registered vault script address whose Position datum owner equals one of the caller's linked payment key hashes, and writes the amount from that output. The client sends only the hash. A unique `tx_hash` means each tx is recorded once.
3. **Live voting weight** — new shared helper `governance-weight.server.ts`: for each registered vault address (or the proposal's asset vault), read current UTxOs from Blockfrost, keep only genuine marked Positions (same decoder as `getVaultChainState`), and value their shares at the live share price.
   - `getMyVotingWeight` / `castVote`: positions owned by the caller's linked wallets.
   - `getEligibleWeights` / `finalizeProposal`: all unspent positions owned by any linked wallet, so quorum uses the same rule as voting.
   - Recorded rows are no longer summed anywhere for weight.
4. **transactions** — `recordVaultTransaction` confirms the tx exists on Blockfrost and touches a registered vault address, then inserts with the server client. A duplicate hash returns "already recorded".
5. **security_audit_log** — `logSecurityEvent` inserts with the server client, using `user_id` from the verified session.
6. **Issuers**
   - `accelerator.functions.ts`: public reads select public columns only. Save and verify return public columns. New `getIssuerPrivate({ issuerId })`: the owner (checked server-side) or an admin gets `contact_email` and `registration_number`.
   - `issuer-workspace.query.ts`: drop `registration_number` from the browser select (the `owner_user_id` filter stays).
   - `issuers.$id.tsx`, `ProjectToolkit.tsx`, issuer edit form: show or pre-fill private fields only from `getIssuerPrivate`.
7. **Types** are regenerated after the migration.

## Risk to check during the build

`verifyData` relies on a WebAssembly library. I will confirm it runs in the published server environment. If it does not, I will check the signature with a small COSE/Ed25519 check built from what is already installed, without adding packages, and tell you.

## Verification

- After the migration: list every policy on every public table and show it to you.
- As a disposable test user: direct writes to `vault_positions`, `transactions`, `security_audit_log` and `linked_wallets` fail. Reading `contact_email` from issuers fails. Another user's draft is invisible. Self-publishing an attestation fails, while editing other fields works. A replayed or expired nonce, or a signature from another wallet, is rejected. Recording the same tx twice is rejected.
- Live wallet signing and on-chain weight with a real Preprod Position cannot be fully exercised without your wallet. I will say exactly what was and wasn't checked.
- Typecheck, existing tests, and page checks of the pipeline, issuer page, issuer dashboard, governance and security pages. Test data is removed afterwards.

## Order

Per your request, after approval I will first show you the final SQL and the code diffs. I apply nothing until you confirm.
