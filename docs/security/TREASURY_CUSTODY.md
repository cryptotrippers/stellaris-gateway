# Treasury custody — Stellaris Shield (31 Oct 2026)

Companion to the Phase 0 baseline (`SECURITY_ARCHITECTURE_BASELINE.md`, PR #41).

## Decisions (31 Oct 2026, Kurt)

1. **G1 treasury:** both — a native multisig treasury first (stopgap), then the full Aiken treasury vault (proposal, delay, limits).
2. **G2 delays:** yes — announce → execute delays for Mint, SetCap, Rotate, first-loss Draw, fv2 Release and ClaimFee, designed now and merged in the one counsel rebuild (preprod-v2).
3. **Audit:** the Shield contracts (treasury vault and the G2 changes) go into the **February 2027** scope. Needs the auditor's agreement to the larger scope; if the date has to move, that comes back as a decision.

## G1 stopgap — native multisig treasury (Preprod)

Code: `scripts/shield/lib/multisig.ts`, `scripts/shield/treasury.ts`. Record: `deployments/shield-preprod.json`.

| | |
|---|---|
| Rule | at least **3 of 5** signatures (native script; no other branch: no timelock, no backup key, no admin) |
| Signers | the five Preprod committee keys (c1–c5) |
| Address | `addr_test1wp3xkv6ay5pjg9nt0q7kx4eh0g4kez4dfwyc2v5fqc5repqpuc9wg` |
| Script hash | `626b335d250324166b783d6357377a2b6c8aad4b8985328906283c84` |

Signer-set checks refuse thresholds below 2, non-majorities, duplicates and malformed keys.

Tests (`tests/contracts/shield-multisig.test.ts`, emulator, ledger validation): ATT-001 (1 key) and ATT-002 (2 keys) refused; ATT-003 (one key signing twice) refused; 3 distinct keys spend and the remainder returns to the treasury; the builder refuses overspend and foreign inputs; the record matches the committee file.

**Limits of the stopgap:** no delay and no rolling limit (the Aiken vault adds both). On Preprod the five keys sit on one PC — not independent signers; mainnet needs separate holders on hardware wallets (build guide 14.5) and a treasury committee separate from the reserve committee (X-3). Deployed scripts with a fixed treasury (sTSRA vault `treasury_addr`, fv2-test-01 `treasury`) keep paying the operator key; the multisig is wired into preprod-v2 and new offerings, and fees already paid to the operator can be moved into it by hand.

## Next: Aiken treasury vault (G1 full)

Design checkpoint before code: datum (signers, threshold, delay, per-tx and rolling caps, window), proposal UTxO (id, destination, assets, earliest/expiry, nonce, domain), execute/cancel rules, rotation with delay, tests for ATT-001…010 and 019/020, budget and size gate.
