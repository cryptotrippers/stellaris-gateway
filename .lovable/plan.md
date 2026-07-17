# Mainnet Readiness — Gap Analysis

Scope: honest assessment of what stands between the current Preprod app and a mainnet launch. No code changes in this response — this is a plan for the work, not the work itself.

## Where we are today

- One Aiken validator (`contracts/vault/validators/vault.ak`) — a **per-user key-hash vault**. Deposit locks ADA under an inline datum `{ owner: pkh }`; withdraw succeeds iff `tx.extra_signatories` contains that PKH.
- Preprod-only browser flows: deposit, withdraw, live holdings via Blockfrost + Lucid Evolution.
- All asset/yield/marketplace/governance/stewardship data is mock (`src/lib/mock-data.ts`). "Investing in sfm-01" only locks ADA in the user's own vault — it doesn't buy anything, doesn't fractionalize, and doesn't pay yield.
- MCP server, Stripe upgrade flow, Blockfrost health card, wallet connect are wired.

The current vault is fine as a UX demo. It is **not** what mainnet needs.

## 1. Smart-contract work (required)

The Phase-1 vault cannot back a real RWA marketplace. At minimum we need:

1. **Per-asset shared vault** (replaces the per-user vault)
   - Datum carries `asset_id`, `issuer`, `total_raised`, `funding_deadline`, `min/target`, optional `hard_cap`.
   - Deposit mints a **fractional receipt token** (CIP-68 reference NFT + fungible user tokens) proportional to lovelace contributed.
   - Redeem/burn path: burn receipt → claim pro-rata payout (principal + yield) after maturity, or refund if funding target missed by deadline.

2. **Fractional receipt token policy** (new minting policy)
   - One policy per asset, or a single parameterised policy keyed by `asset_id`.
   - Enforce: mint only when paired with a matching vault deposit; burn only when paired with a matching vault redeem.

3. **Yield distribution validator**
   - Issuer deposits yield → contract splits pro-rata across outstanding receipt tokens.
   - Options: pull-model (holder submits burn/claim tx) vs push-model (issuer batches payouts). Pull is simpler and safer.

4. **Governance / stewardship contract** (only if governance is a launch feature)
   - Otherwise ship governance as off-chain signalling for v1 and add on-chain later.

5. **Admin/issuer keys + upgrade path**
   - Multi-sig or native-script owned issuer identity (not a single hot key).
   - Explicit "no upgrade" policy per validator, documented — parameterisation via datum, not code.

6. **Audit** (non-negotiable before mainnet)
   - External Aiken/Plutus audit of vault + minting policy + yield contract.
   - Property tests (Aiken `test`), fuzz redeemers, adversarial UTxO tests.
   - Formal invariants: total minted receipts == lovelace-in / rate; no receipt burn without matching principal-out; refund path can't drain other assets' UTxOs.

7. **Mainnet parameters**
   - Rebuild validators with `Network::Mainnet`, mainnet Blockfrost, mainnet script address (`addr1…`).
   - Collateral rules, min-UTxO ADA at mainnet protocol params, fee headroom.

## 2. App features missing (non-contract)

Compliance / regulatory
- KYC/AML gate before deposit (Persona, Sumsub, or similar). RWA offerings are securities in most jurisdictions.
- Accredited-investor / geo-restriction gating.
- Terms of service, risk disclosures, offering memorandum per asset, e-signature capture.
- Data retention & privacy policy, cookie consent (EU).

Issuer / asset lifecycle
- Real issuer onboarding (identity, custody-of-asset attestation, legal wrapper — SPV, trust, or tokenised bond).
- Asset creation flow (currently everything is in `mock-data.ts`) — DB-backed via Lovable Cloud, with issuer role gated by `has_role`.
- Off-chain data attestations for APY, funding %, ESG rating (oracle or signed issuer updates). Today these are hardcoded.
- Secondary-market / transfer story (or explicit "non-transferable until maturity" lockup).

Payments & fiat
- Stripe flow exists for "upgrade" but not for asset purchase. Decide: ADA-only, or fiat-on-ramp → ADA → deposit. Fiat introduces a custodian/MSB requirement.
- Refund / failed-funding money flow.

Auth & accounts
- No user accounts yet (`external_unmanaged` per earlier turn). Mainnet needs auth for KYC state, tax docs, activity history, notifications.
- Server-side role table (`user_roles` + `has_role`) for issuer vs investor vs admin.

Ops & reliability
- Move from live Blockfrost calls per page to an indexer (Blockfrost webhooks → Cloud DB) so holdings, activity, and yield don't depend on Blockfrost being up.
- Alerting on failed txs, stuck UTxOs, contract balance drift.
- Rate limits on the public MCP server (currently no-auth by design) and on any public `/api/public/*` routes.
- Backups and disaster-recovery runbook for issuer keys.

Security
- Rotate/replace `MCP_API_KEY` gating for the two write-ish tools; consider moving stewardship/activity behind auth entirely on mainnet.
- Full security review of edge functions, RLS policies (once Cloud is enabled), and webhook signature verification.
- Content Security Policy, SRI on third-party scripts, dependency audit.

SEO / trust surface (smaller but expected)
- Per-asset `og:image`, legal pages, status page, docs, changelog.

## 3. Suggested phasing

```text
Phase 2  (contracts)  : per-asset vault + receipt token + pull-claim yield
Phase 3  (compliance) : KYC + accounts + issuer onboarding + real asset DB
Phase 4  (ops)        : indexer, alerting, admin console
Phase 5  (audit)      : external audit, testnet bug bounty
Phase 6  (mainnet)    : redeploy with mainnet params, soft launch caps
```

## Direct answer to the question

Yes — new smart-contract calls are required. The current single-validator vault is a demo; mainnet needs at minimum a per-asset vault validator, a fractional-receipt minting policy, and a yield/redeem path, all audited. Everything else (KYC, issuer onboarding, indexer, auth, payments) is app-layer work that also has to land, but it can't ship without the contract rewrite.

## Next step

Tell me which slice to plan in detail next — most likely candidates:
- Phase-2 contract design (datum shapes, redeemers, minting policy)
- KYC + accounts wiring on Lovable Cloud
- Issuer + asset DB replacing `mock-data.ts`
