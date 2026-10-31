# Contract inventory — Stellaris Shield Phase 0 (31 Oct 2026)

Verified from the repository (`main` after PR #39) and the deployment records. Language: **Aiken** (Plutus V3), compiled per project to `plutus.json`; CI rebuilds and fails on drift (`.github/workflows/contracts.yml`, `scripts/verify-vault-hash.mjs`). Off-chain: TypeScript + Lucid Evolution. No mainnet deployment exists; `src/lib/network.ts` refuses mainnet (`MAINNET_NOT_ALLOWED`).

Sizes are compiled bytes from the committed `plutus.json`.

## Rail A — Tessera (`contracts/tessera`, SPEC.md) — deployed on Preprod as `preprod-v1`

| Validator | Size | Parameters | Guards / privileged paths | Deployed |
|---|---|---|---|---|
| `reserve` (Config + Supply spend; TSRA + thread policy) | 12,308 | seed | **M-of-N committee** (3-of-5 on v1): `Mint` (not paused; ≤ min(attested, cap); attestation ≤ 7 days old), `Attest`, `SetCap` (≤ protocol max), `SetPaused`, `SetKyc`, `SetVault`, `OpenLoss` (freeze ≤ 7 d), `CancelLoss`, `LossBurn`. `Rotate` needs current **and** new M-of-N. Anyone: `Burn`, `VaultClaimBurn`. Exact next-datum checks; one Config + one Supply thread | `938b32e0…` (21 Oct) |
| `eligibility` (allowlist policy + registry) | 2,365 | reserve | committee issue/revoke | derived, **not deployed** |
| `stsra_vault` (State, Positions, Tickets; sTSRA + marker policy) | 12,652 | seed, reserve, ops | users: StakeShort/Long, RequestUnstake, Claim (owner-only payout), UnlockLong (owner); committee via ops: ReportYield, ReportLoss, SetBounds (bounded) | `b52a0afb…` (23 Oct) |
| `vault_ops` (withdraw-zero) | 11,100 | reserve | ReportYield/ReportLoss/SetBounds/Claim State side | `32e32973…` |
| `first_loss` | 4,466 | seed, reserve | `Deposit` (from ReportYield); committee `Draw` — **C-2 open (Medium)** | `ccfb81fa…` |
| `redeem_queue` (spend gate + marker policy) | 3,128 | seed, reserve, flow, admin, short | owner `Cancel` — **C-1 open (High): impossible on chain**, shown end to end in `tests/contracts/tessera-browser.test.ts` | `64021fe6…` |
| `queue_flow` (withdraw-zero) | 12,436 | reserve | anyone: Request, Instant (limits), Settle (pays `payout_to` only), Sweep (burns) | `bf2e6f6f…` |
| `queue_admin` (withdraw-zero) | 12,704 | reserve | committee: Fund, Suspend/Resume, **AnnounceLimits → ApplyLimits** (notice), **AnnounceDefund → Defund** (7-day notice, vetoable), GrantGrace — **C-3 open (Low): Grace ADA never reclaimable** | `4a7b639c…` |
| `queue_short` (withdraw-zero) | 11,165 | reserve | stress mode: EnterShort, Register, ExitShort, CancelRegistered, VetoDefund | `8bcf8717…` |

Off-chain: operator scripts `scripts/tessera/*` (bootstrap, stages 5a–5c, attest, send-tsra); browser builders `src/lib/tessera-tx.ts` (PR #38) and `/stake` UI (PR #39); live reader `src/lib/tessera-live.*`.

## Rail B — project offerings (`contracts/fraction-vault`)

| Validator | Size | Guards / privileged paths | Deployed |
|---|---|---|---|
| `offering_v2` (State + thread policy) | 8,117 | keeper or committee: Settle (≤ 15, ≤ hard cap); committee M-of-N (2-of-3 on test): CloseRaise, CancelRaise, **Release** (≤ net proceeds, **to `spv_payout` only**), CommitPeriod, SetFees (≤ 500 bps, Raising only), **ClaimFee** (to `treasury` only), Rotate, BeginWindDown; anyone: FailRaise (after window); holders: RefundFraction, Redeem. Exact balance rule `held = escrowed − released + pool`; immutable terms | `fv2-test-01` (30 Oct) |
| `pledge` (+ marker policy) | 4,423 | owner CancelPledge; anyone RefundPledge (not Raising / after window), payout tagged per pledge | shared, `01b22716…` |
| `fraction_v2` | 1,470 | mint/burn only with the State's accounting | `4eed54e1…` |
| `fraction_vault` (v1) | 5,428 | no release/caps/deadline/refund (engineering audit 26 Oct) | never bootstrapped |
| `fraction` (v1 policy) | 1,134 | — | never bootstrapped |

Off-chain: `src/lib/offering-v2-*.ts` (builders, keeper), `scripts/fv2/*`.

## Legacy (`contracts/vault`, `multi-asset-vault`, `susdr-vault`)

| Validator | Size | Notes |
|---|---|---|
| `vault` (per-user) | 717 | Stage 1 legacy |
| `yield_vault` + `receipt` | 8,077 + 1,209 | F-1…F-6 (AUDIT.md) fixed or mitigated; legacy v3 exit script |
| `multi_asset_vault` | 5,483 | F-1/F-4 pattern |
| `susdr_vault` + `usdr` | 4,603 + 153 | **frozen** — do not bootstrap |

Decision pending (build guide 13.5): audit them or retire them.

## Not in the repository (verified absent)

- A protected **treasury vault** (proposal + timelock + rolling limits) for protocol income or operating funds. Treasury on Preprod is a single key (`vault.treasuryAddress` = operator; `fv2` `treasury` = operator key hash).
- An on-chain **reserve custody** contract: the TSRA backing is off chain and **attested** by the committee (SPEC.md §1, DESIGN §7.4 — open with counsel). The queue Buffer (tUSD shards) is the only reserve value held on chain.
- An **oracle** or third-party attestation feed.
- **Midnight** code (design only, `claude/meridian-proposal-2026-10-25.md`).
- Contract **upgrade** paths: every script is immutable; changes are new deployments (preprod-v2).
