# Security invariants — Stellaris Shield Phase 1 (31 Oct 2026)

Each invariant from the Shield brief, mapped to what enforces it today and the executable evidence. **Status** is per scope: EXISTING (enforced on chain, tested), PARTIAL, MISSING, BLOCKED (needs a decision outside engineering).

"Committee" = the reserve committee (Tessera, 3-of-5 on preprod-v1) or the offering committee (fv2, 2-of-3 on the test offering).

| ID | Invariant | Scope | Status | Enforced by | Evidence |
|---|---|---|---|---|---|
| INV-001 | No unilateral reserve withdrawal | Tessera on-chain value (vault, first-loss, queue Buffer) | **EXISTING** (one gap: C-2) | Every value-moving committee action needs M-of-N; user exits pay only the owner; Settle pays only `payout_to` | `contracts/tessera` tests (1,372); `tests/contracts/tessera-attest.test.ts` (2-of-5 refused); C-2 exploit test in review scratch |
| | | fv2 offering escrow | **EXISTING** | Release (M-of-N, ≤ net proceeds, SPV only), ClaimFee (treasury only); refunds need no committee | `fv2_scenarios.ak`, `tests/contracts/fv2-emulator-attacks.test.ts` |
| | | Protocol treasury / operating funds | **MISSING** | Single key address on Preprod | — |
| INV-002 | Independent M-of-N approval | On-chain threshold | **EXISTING** | distinct signer counting in reserve, queue_admin, offering_v2 | tests above |
| | | Signer independence | **PARTIAL (Preprod only)** | All five test committee keys sit on one PC — *not* independent signers. Mainnet key ceremony (build guide 14.5) | — |
| INV-003 | Asset conservation | Tessera State/Supply, fv2 State | **EXISTING** | exact next-datum + exact value (F-6 pinning), fv2 exact-balance rule | Aiken suites; mutation pass fv2 (293/324 killed, 31 equivalent) |
| INV-004 | No unauthorised TSRA issuance | Mint cap and freshness | **EXISTING** | `minted + qty ≤ min(attested_reserve, mint_cap)`, attestation ≤ 7 d, M-of-N, not paused | `tessera-attest.test.ts` (stale → refused) |
| | | Reserve existence and ownership | **BLOCKED** | Attestation is committee-asserted; no custodian proof or oracle. Needs counsel (DESIGN §7.4) and a custodian | — |
| INV-005 | Proposal + on-chain delay for large movements | Queue Defund, limit changes | **EXISTING** | AnnounceDefund → 7-day notice → Defund (vetoable); AnnounceLimits → ApplyLimits | queue_admin tests |
| | | Mint, SetCap, Rotate, Release, ClaimFee, Draw | **MISSING** | Immediate with M-of-N | — |
| INV-006 | Withdrawal limits, no split bypass | Redemptions (Instant/Settle) | **EXISTING** | per-shard daily/monthly caps in shard state; caps = global ÷ shards so splitting across shards can't exceed the global cap | queue tests; `tessera-browser.test.ts` (above max refused) |
| | | Treasury spending | **MISSING** | no treasury contract | — |
| INV-007 | Emergency powers can't seize | Pause, Suspend, loss freeze | **EXISTING** | SetPaused blocks Mint; Burn and user exits work while paused; loss freeze ≤ 7 d (4 d in the fix batch); queue Suspend ≤ 3 days; Cancel/refund paths read no switch | SPEC §3, §4.3a; tests |
| | | ReportLoss | **PARTIAL** | committee can lower the loss index (D-13, disclosed); cannot pay anyone | known finding for audit |
| INV-008 | Asset segregation | reserve / first-loss / vault / queue / offerings | **EXISTING** | separate scripts and thread tokens; offering scripts never touch Tessera reserve assets (standing rule) | — |
| | | Treasury vs operating vs project escrow off chain | **MISSING** | treasury = operator key | — |
| INV-009 | Replay protection | All signed actions | **EXISTING** (by construction) | Signatures are over the tx body (network id, exact inputs); one-shot seeds and thread tokens; fv2 payout tags (double satisfaction) | fv2 attack tests |
| INV-010 | Safe upgrades | All scripts | **EXISTING** (immutable) / **PARTIAL** (governance) | No upgrade path exists; changes are new deployments. Rotate needs old + new committee. No timelock on Rotate | — |
| INV-011 | No hidden bypass | All redeemers | **PARTIAL** | Privilege tables in SPEC.md / SPEC-v2.md; external audit pending (Feb 2027) | `CONTRACT_INVENTORY.md` |
| INV-012 | Verifiable state transitions | Shared States | **EXISTING** | thread tokens (F-1), markers (F-4), exact datums; contention handled off chain (rebuild, never auto-resubmit) | emulator suites; contention test in `tessera-browser.test.ts` |

## Summary

- **On-chain reserve and escrow value is already protected by M-of-N, exact accounting, bounded emergency powers and on-chain limits.** Two open contract findings (C-1 High, C-2 Medium) and C-3 (Low) are fixed on `phase2-9-security-fixes`, waiting for the counsel rebuild.
- **The real gaps are around them:** (1) protocol treasury / operating funds are a single key; (2) committee actions other than Defund and limits have no proposal delay; (3) reserve existence is attested, not proven; (4) on Preprod the committee keys are not independent.
