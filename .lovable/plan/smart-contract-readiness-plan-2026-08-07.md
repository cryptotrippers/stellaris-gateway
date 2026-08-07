# Smart contract readiness plan

## Goal
Move the Cardano vault from the current Preprod Stage 3 validator to a mainnet-ready, independently reviewable protocol without skipping ownership, accounting, migration, or operational safety gates.

## Verified starting point
- The active validator is parameterized by `(version, asset_id)` and the app pins `VAULT_VERSION = 2` with the Stage 3 blueprint hash.
- The validator currently supports `Withdraw`, owner-signature enforcement, owner-directed output enforcement, and owner-preserving inline-datum continuity for partial withdrawals.
- Local Aiken validation is documented at 10 checks with 0 errors and 0 warnings.
- Version-1 and version-2 addresses are intentionally different; version-1 UTxOs still require a separate recovery path.
- The project is still Preprod-only. Receipt tokens, pull-model yield/refunds, reference scripts, external audit, KYC enforcement, legal wrappers, and a multisig treasury are not yet complete.

## Ordered steps and gates

### 0. Freeze scope and create the contract specification
Document the exact asset, deposit, partial withdrawal, full withdrawal, migration, yield/refund, timelock, and emergency behaviors before changing the validator.

**Gate:** every state transition has defined datum fields, redeemer, authorized signers, value conservation rules, and failure cases.

### 1. Finish and record the current Stage 3 Preprod proof
Derive and record the version-2 address for each supported asset, then run a fresh deposit, full withdrawal, and partial withdrawal. For the partial withdrawal, verify on-chain that the remainder keeps the same owner datum.

**Gate:** reproducible build/hash check passes; all three transactions confirm; no version-1 address is funded by the new app.

### 2. Add the version-1 legacy recovery path
Keep the retired version-1 blueprint and address available for read-only discovery and owner-authorized withdrawal. Do not mix legacy UTxOs with version-2 spending logic.

**Gate:** every known version-1 UTxO can be identified by asset/version and recovered by its owner, with no new version-1 deposits accepted.

### 3. Complete adversarial ownership and isolation tests
Use a second wallet to test that foreign UTxOs cannot be withdrawn. Add negative tests for wrong signer, wrong owner output, malformed/missing datum, re-datumed continuation, cross-asset address use, duplicate input handling, and unauthorized aggregation.

**Gate:** Aiken unit/property tests pass and the live second-wallet rejection is recorded before any mainnet decision.

### 4. Specify the shared-vault accounting model
Define how a deposit maps to ownership, shares, asset exposure, decimals, rounding, fees, partial withdrawals, dust, and insolvency. Choose whether the receipt token is a transferable position token or a non-transferable accounting receipt; define mint, burn, and supply invariants.

**Gate:** the accounting specification can reconcile total vault assets, receipt supply, and each holder position for deposits, withdrawals, and rounding cases.

### 5. Implement the receipt-token and shared-vault validator
Replace the current owner-datum-only position model with the approved per-asset shared-vault model. Add receipt-token mint/burn authority, datum/version checks, exact value/share accounting, authorized withdrawal rules, and protections against double satisfaction and token/value mismatch.

**Gate:** the new blueprint is reproducible; unit, property, and negative tests cover all transitions; old versions remain recoverable and are not silently upgraded.

### 6. Implement the pull-model yield and refund path
Define how yield, principal refunds, losses, fees, and oracle updates are claimed by users rather than pushed into arbitrary outputs. Bind every claim to the correct asset, receipt balance, epoch/valuation, and authorized source.

**Gate:** no claim can be duplicated, redirected, claimed with stale state beyond the allowed policy, or create value without a corresponding funded source.

### 7. Add time controls, governance controls, and emergency behavior
Encode the final withdrawal timelock/cancellation rules, governance-controlled parameter changes, pause/emergency recovery policy, and upgrade/versioning policy. Separate user funds from treasury actions and avoid irreversible admin powers without an explicit governance or multisig path.

**Gate:** every privileged action has a signer threshold, delay, audit event, and tested failure/recovery path.

### 8. Optimize deployment with reference scripts
Choose the reference-script deployment and upgrade strategy, including publication, script integrity verification, minimum-ADA funding, datum compatibility, and how clients discover the active script version.

**Gate:** a Preprod transaction uses the reference script successfully and the app refuses an unknown hash/version.

### 9. Run external security, economic, and legal review
Commission an independent contract audit, threat model, economic/accounting review, and asset-specific legal review. Publish the final report, commit hash, scope, exclusions, and remediation status to the contract-audit registry.

**Gate:** no unresolved critical/high findings and the deployed hash exactly matches the reviewed commit.

### 10. Wire compliance and treasury prerequisites
Connect real KYC/AML eligibility enforcement where legally required, publish asset legal wrappers/disclosures, configure the multisig treasury, and ensure governance approval is required before treasury funding or parameter changes.

**Gate:** compliance failures block the affected on-chain action; treasury configuration is populated with the approved multisig only; no UI badge is treated as proof of eligibility.

### 11. Mainnet rehearsal and controlled launch
Repeat the complete test matrix on a mainnet-like Preprod release, verify monitoring/alerts, recovery runbooks, transaction indexing, address/version configuration, and rollback boundaries. Deploy only the audited immutable blueprint, start with a capped asset and deposit limit, then increase limits only after observed operation.

**Gate:** signed release checklist, published hashes/addresses, monitoring coverage, support/recovery procedure, and explicit go/no-go approval.

## Technical implementation order
1. Contract spec and test vectors.
2. Current Stage 3 live proof and legacy recovery.
3. Adversarial/property test harness.
4. Receipt-token/shared-vault validator.
5. Yield/refund and timelock/governance validators.
6. Reference-script packaging and client version discovery.
7. Audit remediation and immutable release.
8. Compliance, multisig treasury, rehearsal, and capped mainnet launch.

Each stage stops at its gate; the next stage does not begin until the evidence is recorded in the deployment notes and changelog.