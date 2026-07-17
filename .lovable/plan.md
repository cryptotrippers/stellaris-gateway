
# Institutional Readiness Plan

This is a multi-week program, not a single turn. Below is an honest slicing of what I can implement in code now, and what has to be decided or purchased by a human first. I will land the work in the numbered phases and, after each phase, tell you exactly what's shipped vs. still blocking.

## Guiding principle

If a number can't be sourced from Supabase or an on-chain query in this repo, it does not render. Every current placeholder becomes either (a) a real query, or (b) an explicit empty state. No exceptions, no "for now" numbers.

---

## Phase A — Purge fabricated data (code only, I can do this)

Scope: every page audited for hardcoded numbers, badges, tx hashes, and demo rows.

1. Grep pass across `src/routes/**`, `src/components/**`, `src/lib/mock-data.ts`. Every literal statistic (TVL, APY, "27,392 investors", tx hashes like `f3a2…`, "3 audits", "ZK-Verified", "Audited by Certik", uptime %) gets tagged.
2. For each tagged value, one of three fates:
   - Wire to an existing Supabase table or a live query (Blockfrost / server fn).
   - Move behind a real status column on a new/existing table (`is_verified`, `audit_report_url`, `oracle_feed_id`) and only render when that column is populated.
   - Replace with an explicit empty state ("No audit report published yet", "No oracle feed connected", "0 investors").
3. Delete `src/lib/mock-data.ts` entirely once nothing references it, so it can't creep back.
4. Marketplace assets move from the mock file to a real `assets` table with issuer, status, `audit_report_url`, `oracle_feed_id`, `min_deposit_lovelace`, `funding_status`. Migration + GRANTs + RLS in the same change.

Human decisions this needs: none. This is a code sweep.

---

## Phase B — Contract production hardening (code + external audit)

Scope: bring `contracts/vault/validators/vault.ak` up to something an auditor can actually read.

1. Rewrite the vault as a per-asset shared vault with a receipt-token minting policy (already sketched in `.lovable/plan.md`). Datum: `{ asset_id, issuer, total_raised, deadline, min, target, hard_cap }`.
2. Add Aiken `test` blocks and property tests: pro-rata invariant, no-mint-without-deposit, no-burn-without-withdraw, refund-only-past-deadline, double-satisfaction guard (each script input consumed by exactly one continuing output).
3. Reference-script deployment path: build script, publish once as a reference UTxO, update `src/lib/vault.ts` to attach the reference input instead of embedding script bytes per tx. Materially lower fees for the ₳10 minimum use case.
4. Deterministic build: pin `aiken` version in `contracts/vault/aiken.toml`, add a `contracts/README.md` with the exact `aiken build` / `aiken check` / `aiken blueprint apply` commands and expected blueprint hash, plus a GitHub Actions job that fails if the built blueprint hash drifts.
5. Publish the contract source, blueprint, and CIP-52-shaped audit-readiness document in-repo under `contracts/`.
6. In the app: replace the "Audited" badge with a card that reads a real `contract_audits` row — auditor name, report URL, commit hash, date. If no row: "No audit report published yet." No badge until the row exists.

Human decisions this needs:
- Engaging an actual audit firm (Anastasia Labs, TxPipe, Certik, MLabs) and their fee. I can prepare the audit package; I can't sign the contract.
- Deciding whether Phase B ships to mainnet before or after audit lands.

---

## Phase C — Portfolio / security / governance already partly wired

Portfolio (`/app`), security (`/security`), and governance (`/governance`) reads and audit logs are already live-queried in the current codebase. In Phase A I'll re-audit them for any residual hardcoded fallback (e.g. "24h yield" derivations that still assume mock rows) and either back them with a real derivation from `transactions` + `vault_positions` or hide them.

Governance specifically:
- Model tables after CIP-1694 shapes (`gov_action_id`, `action_type`, `deposit`, `expires_at`, DRep/SPO/CC vote tallies), not the current single-percentage row.
- Add a `governance_source` enum: `on_chain` (read from a Koios/Blockfrost governance action indexer) or `off_chain_snapshot` (labelled clearly in the UI as non-binding signalling).
- The console renders a big "OFF-CHAIN SIGNAL — non-binding" ribbon whenever `governance_source = off_chain_snapshot`. No pretending.

Human decisions:
- Whether we index on-chain governance actions ourselves via Blockfrost `/governance/*` endpoints or use Koios. I recommend Blockfrost since we already have a project ID.
- Whether v1 launches as off-chain signalling only, with on-chain wiring in a follow-up.

---

## Phase D — Midnight ZK-KYC integration point

Static "ZK-Verified" badge is deleted in Phase A. In its place:

1. New `kyc_attestations` table: `user_id`, `subject_stake_address`, `attestation_type` (`accredited` / `sanctions_clear` / `jurisdiction_ok`), `proof_cid`, `verified_at`, `expires_at`, `verifier` (`midnight` / `manual`).
2. Server function that accepts a Midnight proof artifact, verifies it against a Midnight verifier endpoint, and inserts the attestation. Deposit path gates on a valid non-expired attestation for the required type.
3. UI: a real KYC step in the deposit flow. When no attestation exists, we render "KYC required to invest. Start ZK verification" — that button initiates the Midnight flow. When an attestation exists, we render its proof CID and expiry, not a decorative badge.
4. Wallet-only paths (browsing, connecting) never require KYC. Only `deposit` and `governance vote` gate on it, and only when the asset/action requires it.

Human decisions this needs:
- Which Midnight verifier / KYC vendor pairing you use (IDNow + Midnight, Fractal ID + Midnight, in-house). Midnight is currently devnet-stage; a real production integration probably means dev-partner status with IOG/Midnight. I can wire the interface and stub the verifier against Midnight's testnet, but a real production issuer relationship is your call.
- Jurisdictional scope of the offering (US Reg D vs. EU MiCA vs. non-US only). This changes which attestation types matter.

---

## Phase E — Oracle wiring (Charli3 / Orcfax)

1. New `oracle_feeds` table: `feed_id`, `provider` (`charli3` / `orcfax`), `pair`, `feed_utxo`, `feed_address`, `last_observed_at`, `last_price`, `last_tx_hash`. Populated by a scheduled server route that reads the feed UTxO via Blockfrost.
2. Each `asset` row optionally points at one `oracle_feed_id`. Vault detail page shows the actual feed reference (address + latest observation tx hash on cardanoscan) instead of a badge. No feed connected → "No oracle feed connected for this asset."
3. Contract-side: the redeemer for yield distribution (Phase B) can be constrained to consume the oracle feed UTxO as a reference input. Documented as a required test case for the auditor.

Human decisions:
- Which provider per asset class. Charli3 for ADA/USD, Orcfax for broader RWA-adjacent feeds. Both charge for production feeds; that's a contract with the oracle DAO, not code.

---

## Phase F — Protocol treasury & buyback dashboard

1. `treasury_config` table (single row): `treasury_address`, `buyback_pct_bps`, `active_since_slot`.
2. `treasury_events` table: every fee-collection tx and every buyback tx, indexed from Blockfrost webhook into Supabase. Only `provenance = on_chain` rows render.
3. Public `/treasury` route (no auth needed): shows the treasury address as a clickable Cardanoscan link, running total of fees collected, running total of ADA bought back, and the full list of buyback tx hashes with links. Every number derived from indexed on-chain data — never a config value.
4. If zero events: "Treasury active since slot X. No buybacks executed yet." Honest empty state.

Human decisions:
- The actual `treasury_address` (native script multisig recommended, not a hot key).
- The buyback percentage. This is a governance parameter, not something I should pick.

---

## Phase G — Financial inclusion / mobile / fee transparency

1. Mobile-first pass on `/app`, `/marketplace`, `/marketplace/$id`, deposit and withdraw flows. Design tokens are already there; work is a layout audit and touch-target sweep.
2. Deposit UI shows the actual protocol fee, min-UTxO, and Cardano tx fee **for the specific amount the user typed**, computed via Lucid's fee estimator, before the wallet signature prompt. At ₳10, this is the make-or-break number — if fees eat 30% at that size, the min needs to change or reference scripts need to land first (Phase B item 3).
3. Plain-language copy pass. Every "APY", "slippage", "epoch", "DRep" is either replaced with plain English or paired with a one-sentence inline definition. No hover-only tooltips for critical safety text.
4. `Content-Language`, semantic HTML, keyboard nav, prefers-reduced-motion respected end-to-end.
5. Slow-connection: audit third-party script tags, defer non-critical JS, ensure the marketplace list renders server-side (TanStack Start SSR is already on) with a small initial JS payload.

Human decisions: none for the code work. Localization languages beyond English is a scope call.

---

## Phase H — Repo transparency

1. Public `CHANGELOG.md`, updated per release, not hand-maintained per feature.
2. Root-level `NETWORK.md` and an in-app persistent badge (already partly built by `NetworkBadge`) that make testnet vs. mainnet impossible to confuse.
3. `.well-known/security.txt` served from the app with a real disclosure contact and PGP key, per RFC 9116.
4. `SECURITY.md` with responsible-disclosure policy, scope, safe-harbor language, and response SLA.
5. Public repo. This is a workspace-level action, not a code change I can push.

Human decisions:
- Real security contact email + PGP key.
- Whether the repo is fully public or source-available with a specific license. My default recommendation: Apache-2.0 for the contracts, source-available for the app.

---

## Suggested execution order

```text
A  purge fabricated data                 (I do it, ~1 turn)
H  security.txt, changelog, network doc  (I do it, ~1 turn)
G  fee transparency + mobile pass        (I do it, 2-3 turns)
C  governance schema aligned to CIP-1694 (I do it, 1-2 turns)
F  treasury/buyback dashboard scaffold   (I do it; needs your address to activate)
E  oracle feed table + reader            (I do it; needs provider choice to go live)
D  Midnight ZK-KYC interface + stub      (I do it; needs vendor/partner decision)
B  contract rewrite + audit package      (I do it; audit itself is external)
```

## What only a human can decide

- Audit firm engagement and fee.
- KYC / Midnight partner and jurisdictions in scope.
- Oracle provider per asset.
- Legal wrapper per asset (SPV, trust, tokenised bond).
- Treasury multisig signers and buyback percentage.
- Security disclosure contact + PGP key.
- Repo license and visibility.
- Whether v1 ships governance as on-chain or clearly-labelled off-chain signalling.

## What I need from you now

Confirm the order above (A → H → G → C → F → E → D → B) and I start with Phase A: full audit and removal of fabricated numbers, tx hashes, and badges across every route, replacing each with either a live query or an honest empty state. Or reorder and I'll follow that.
