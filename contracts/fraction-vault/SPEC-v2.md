# `fraction_vault` v2 — specification (E05)

Status: **draft for approval**, 27 Oct 2026. Nothing in this document is built
yet. Approving it unblocks E06 (Aiken scripts), E07 (builders and tracker) and
E09 (snapshot, manifest and payouts).

v1 (`validators/fraction_vault.ak`, `validators/fraction.ak`) stays in the repo
unchanged. No v1 offering has been bootstrapped (`OFFERING_SEEDS` is empty), so
v2 replaces it without a migration; v1 is retired once v2 is on Preprod.

## 1. Decisions this spec applies

| ID | Decision (27 Oct 2026, Kurt) | Effect on v2 |
| --- | --- | --- |
| D-6 | Pledges + state, pilot target about 50 investors | Two spending scripts: `pledge` (one UTxO per investor commitment) and `offering_v2` (the single state). Buyers never contend. |
| Audit | v2 goes to a second audit, after the February 2027 Tessera audit | No pressure to shrink v2 below what the pilot needs. |
| D1 | Approved off-chain manifest, batched push payments | Distributions never pass through the state. `CommitPeriod` records each period's manifest Merkle root. A claim script is later work (Build Guide 15.2). |
| D-5 | Free transfers on Preprod; mainnet restrictions reviewed with counsel | The fraction token is an ordinary native asset. Its minting policy is named in the datum, so a restricted policy can be used for a later offering without redesigning v2. |
| D3 | Pay in TSRA on Preprod; mainnet asset explored (section 9) | Deposit unit and payout unit are both TSRA on Preprod. The unit is a script parameter, as in v1, so another unit is a new parameterisation, not a new contract. |
| D-7 | Issuer protections set per asset type in the term sheet | Enforced in the Meridian ledger. On-chain, v2 only caps releases at net proceeds minus an optional retained amount. |
| X-1 | TSRA is a payment medium, never reserve backing | TSRA paid into an offering is project cash. Nothing in v2 touches Tessera's reserve, vault or first-loss scripts. |
| X-3 | Separate offering committee before mainnet | The committee is per offering, in the datum, and is not the reserve committee. |

## 2. Lifecycle

```
            Pledge / CancelPledge (investors, any time before the deadline)
                                  │
 Open ──► Raising ──Settle* (keeper or committee, up to the hard cap, until deadline + settle window)
                │
                ├── CloseRaise (committee; settled ≥ soft cap) ──► Operating ──Release* / CommitPeriod*
                │                                                     │
                │                                                     └── BeginWindDown (committee) ──► WindingDown ──Redeem* ──► Closed
                │
                └── FailRaise (anyone, after deadline + settle window, settled < soft cap)
                    or CancelRaise (committee, before CloseRaise) ──► Refunding ──RefundFraction* / RefundPledge* ──► Closed
```

`*` = repeatable. A state transition is legal only along these arrows.

Timing parameters, all POSIX milliseconds in the datum:

- `deadline`: last moment a pledge counts. Pledges created after it are refundable at once.
- `settle_window`: time after the deadline for settling outstanding pledges. 7 days by default.
- A raise that is neither closed nor failed by `deadline + settle_window` can always be failed by anyone. Money is never stuck waiting for the committee.

## 3. Scripts

| Script | Kind | Parameters | Job |
| --- | --- | --- | --- |
| `offering_v2` | spend + mint (state-thread token) | `seed`, `version`, `asset_id`, `unit_policy`, `unit_name` | The single state UTxO: counters, caps, escrowed units, lifecycle, releases, period roots. |
| `pledge` | spend | `offering_hash` (applied `offering_v2` hash) | Holds one investor's commitment until it is settled, cancelled or refunded. |
| `fraction_v2` | mint | `offering_hash`, `asset_id` | Default fraction policy. Mints exactly the fractions a `Settle` records; burns exactly what `RefundFraction` / `Redeem` record. Token name = asset id, as in v1. |

The state is identified only by its thread token (AUDIT.md F-1), never by datum
shape. Every builder and reader selects it the same way as v1 does.

Reference scripts are mandatory for all three. Each script must stay under the
13,000-byte CI gate (E16).

## 4. Datums

### 4.1 State (`OfferingV2`)

| Field | Type | Rule |
| --- | --- | --- |
| `status` | `Raising` \| `Operating` \| `Refunding` \| `WindingDown` \| `Closed` | Moves only along section 2's arrows. |
| `total_fractions` | Int > 0 | Hard cap in fractions. Immutable. |
| `soft_cap` | Int, 0 < soft_cap ≤ total_fractions | Fractions that must be settled for the raise to succeed. Immutable. |
| `price` | Int > 0 | Units of the deposit unit per fraction (TSRA has 6 decimals). Immutable. |
| `deadline`, `settle_window` | Int | See section 2. Immutable. |
| `settled` | Int | Fractions minted by `Settle`, cumulative. ≤ `total_fractions`. |
| `outstanding` | Int | Fractions in circulation. Equals `settled` until refunds or redemptions burn some. |
| `escrowed` | Int | Units paid in by settled pledges, less fees claimed and refunds paid. Includes `fees` until they are claimed. |
| `released` | Int | Units released to the SPV so far. |
| `retained` | Int ≥ 0 | Units that may never be released (D-7 on-chain hold-back; 0 unless the term sheet asks for one). Immutable. |
| `fees` | Int | Accrued platform fees, unclaimed. |
| `fee_bps` | Int, 0–500 | Fee on settled proceeds, as v1's mint fee. Moves only by `SetFees`. |
| `pool` | Int | Units held for holders in `WindingDown` (final sale proceeds). |
| `period` | Int | Last committed distribution period. Starts at 0. |
| `manifest_root` | ByteArray (32) or empty | Merkle root of the last committed period's payout manifest. |
| `docs_hash` | ByteArray (32) | Hash of the offering document set investors accepted. Immutable. |
| `spv_payout` | Credential | The only place `Release` may pay. Immutable. |
| `treasury` | key hash | The only place `ClaimFee` may pay. Immutable. |
| `committee`, `threshold` | List<key hash>, Int | Offering committee, M-of-N. Changing it needs the current M-of-N (`Rotate`). |
| `fraction_policy` | PolicyId | The fraction token. `fraction_v2` by default; a restricted policy later if counsel requires (D-5). Immutable. |
| `eligibility_policy` | Option<PolicyId> | If set, a pledge settles only when its owner holds that eligibility token (Tessera `eligibility`). `None` on Preprod. Immutable. |

Derived values, never stored:

- `net_proceeds = escrowed_at_close − fees_at_close`
- `release_cap = net_proceeds − retained`

### 4.2 Pledge

| Field | Type | Rule |
| --- | --- | --- |
| `offering` | thread-token unit | Which offering this pledge is for. |
| `owner` | key hash (+ optional stake key) | Refunds and fractions go only to this address. |
| `qty` | Int > 0 | Fractions pledged. |
| `created` | Int | Lower validity bound of the pledge tx. A pledge created after the deadline is refundable at once. |

The pledge UTxO must hold exactly `qty × price` units plus min-ADA. Anything
else is a malformed pledge and is refundable by anyone, to the owner, at any
time.

## 5. Redeemers, rules and threats

### 5.1 `pledge` script

| Redeemer | Who | Rules | Threats it closes |
| --- | --- | --- | --- |
| `CancelPledge` | owner signature | State is `Raising` and before the deadline. All value goes to `owner`. | A third party cancelling someone else's pledge. |
| `RefundPledge` | anyone | State is `Refunding` or `Closed`, or now > deadline + settle_window, or the pledge is malformed or late. All value goes to `owner`; the tx may add only the caller's own fee inputs. | Refunds held hostage by the committee; griefing by paying the refund elsewhere. |
| `SettlePledge` | anyone | The same tx spends the state with `Settle` and lists this pledge. | Settling a pledge without the state's accounting running. |

### 5.2 `offering_v2` state

| Redeemer | Who | Rules |
| --- | --- | --- |
| `Open` (mint thread token) | issuer + committee M-of-N | Consumes `seed`. Mints exactly one thread token into a state output with `status = Raising` and all counters 0. Checks caps, fees ≤ 500 bps and committee shape. |
| `Settle { pledges }` | keeper or committee | `Raising`, before deadline + settle window. For each listed pledge: right offering, well-formed, created before the deadline, owner eligible if `eligibility_policy` is set. Mints exactly Σqty fractions, each owner receiving their own `qty` at their own address. `settled + Σqty ≤ total_fractions`. `escrowed += Σ(qty × price)`; `fees += bps_of(Σ, fee_bps)`. Batch size is set by the budget report (E06). |
| `CloseRaise` | committee M-of-N | `Raising`, `settled ≥ soft_cap`. → `Operating`. Records `net_proceeds`. |
| `FailRaise` | anyone | `Raising`, now > deadline + settle window, `settled < soft_cap`. → `Refunding`. Fees accrued during the raise are cancelled (refunds are fee-free). |
| `CancelRaise` | committee M-of-N | `Raising`. → `Refunding`, fees cancelled. For a raise that must stop early (counsel, issuer withdrawal). |
| `RefundFraction { qty }` | any holder | `Refunding`. Burns `qty` fractions and pays exactly `qty × price` to the caller. |
| `Release { amount, evidence_hash }` | committee M-of-N | `Operating`. `released + amount ≤ release_cap`. Pays exactly `amount` to `spv_payout` only. `evidence_hash` (32 bytes) is the hash of the milestone evidence the reviewer approved; it is kept in the redeemer and mirrored in the ledger. |
| `CommitPeriod { period, manifest_root }` | committee M-of-N | `Operating` or `WindingDown`. `period = old + 1`. Moves no value. |
| `SetFees { fee_bps }` | committee M-of-N | `Raising` only, ≤ 500 bps. |
| `ClaimFee { amount }` | committee M-of-N | `Operating` or later. ≤ `fees`, paid only to `treasury`. |
| `Rotate { committee, threshold }` | current M-of-N | New committee well-formed. |
| `BeginWindDown { final_pool }` | committee M-of-N | `Operating`. Pays `final_pool` units into the state (sale proceeds); unreleased escrow joins the pool. → `WindingDown`. |
| `Redeem { qty }` | any holder | `WindingDown`. Burns `qty`, pays `floor(pool × qty / outstanding)` to the caller; remainder stays with the remaining holders (v1 rule). Last fraction burned → `Closed`. |

Invariants every redeemer must keep (each gets a named test):

1. Exactly one state input and one state output, carrying the thread token; datum always readable.
2. Script outputs hold only lovelace, the deposit unit and the thread token (v1's clean-value rule, blocks token-flood attacks).
3. Fractions minted − burned in a tx = change in `outstanding`, enforced by both `offering_v2` and `fraction_v2`.
4. The state's unit balance reconciles after every tx: `balance = escrowed − released + pool`. `ClaimFee` lowers both `fees` and `escrowed`; `RefundFraction` lowers `escrowed`; `BeginWindDown` moves unreleased, unowed escrow into `pool`; `Redeem` lowers `pool`.
5. `released ≤ release_cap` always; `Release` never pays anyone but `spv_payout`.
6. Every immutable field in 4.1 is unchanged through every spend.
7. Refund paths (`RefundPledge`, `RefundFraction`) need no committee signature, ever.
8. Nothing pays the committee or the issuer directly except `Release` (to the SPV) and `ClaimFee` (to the treasury).

## 6. Distributions (D1), on Preprod in TSRA

1. The Meridian ledger closes and approves the period: preparer ≠ approver, root recorded (E03, done).
2. A snapshot of fraction holders at the record-date block is taken from chain data (E09). Holders at script addresses get an explicit policy (withheld until claimed by their owner), as finding C-04 requires.
3. `allocate` computes entitlements in AUD cents, floored, with the remainder carried (D4).
4. The approved manifest is converted to TSRA at the rate recorded at FUNDED (D3).
5. The manifest's Merkle root is committed with `CommitPeriod`.
6. The distribution wallet (a committee multisig) pays every holder in batched transactions (about 50 holders = one transaction).
7. Each payment is matched back to the manifest by tx hash; the ledger marks entitlements paid exactly once (I-B6).

Payouts below a minimum (proposed: 2 TSRA) roll over to the next period, because each Cardano output also carries about 1–1.3 ADA.

## 7. Off-chain work this spec implies

| Item | What |
| --- | --- |
| E07 | Builders: `openOffering`, `pledge`, `cancelPledge`, `refundPledge`, `settleBatch` (keeper), `closeRaise`, `failRaise`, `refundFraction`, `release`, `commitPeriod`, `beginWindDown`, `redeem`. All go through `signGuarded` (S1), with intent rules added for each. A tx tracker handles confirmation depth and rollbacks. |
| E09 | Snapshot at record date, manifest builder, batched payout builder, reconciliation. |
| E10 | Nightly job: state balance equals invariant 4; no pledge older than deadline + window left unrefunded or unsettled. |
| Ledger | `Release` and `CommitPeriod` tx hashes recorded as ledger provenance (`chain_tx`). |

## 8. Tests required before E06 counts as done

- Unit tests per redeemer, accept and reject paths.
- Mutation tests: every non-equivalent mutant killed (as for Tessera).
- Adversarial emulator tests, at least:
  - double settle of one pledge, and settle of a cancelled pledge;
  - settle after deadline + window; settle beyond the hard cap;
  - close below the soft cap; fail above it;
  - release above the cap, to another address, or in the wrong status;
  - refund paid to someone other than the owner; refund blocked by a committee step;
  - pledge for another offering; pledge with the wrong amount;
  - a state datum without the thread token; two state outputs;
  - fraction mint without the state; burn outside `Refunding` / `WindingDown`;
  - token flood on the state output.
- Budget report for `Settle` at N = 1, 5, 10, 20 pledges, with at least 20% headroom under the protocol per-transaction limits. The largest N that passes sets the keeper's batch size.
- Script-size report: each script under 13,000 bytes.

## 9. Mainnet payout asset — options explored

Entitlements stay fixed in AUD cents at approval, whatever is paid. The payout
rail takes any native asset, so this choice can be made late.

| Option | Strengths | Risks and open questions | When it fits |
| --- | --- | --- | --- |
| TSRA (Preprod choice) | One unit from purchase to payout; holders can stake into sTSRA; no third party. | TSRA must be audited and legally characterised first (Build Guide 12.2). Concentration: a TSRA problem hits every project's payouts. | Mainnet, once Tessera is audited and counsel clears TSRA as a payment medium. |
| USDCx (Circle, via xReserve) | Largest stablecoin on Cardano since its Feb 2026 launch; widely held; backed 1:1 by USDC. | Bridge can be suspended; redemption goes back to Ethereum; AUD→USD conversion needed. | Mainnet before TSRA is cleared, or as an option holders choose. |
| USDM / USDA | Native Cardano fiat-backed stablecoins; USDM held by the Cardano treasury. | Smaller liquidity; issuer risk; same AUD→USD conversion. | Alternative to USDCx. |
| AUD bank transfer (off-chain) | Matches AUD income exactly; no currency conversion. | Bank details held off-chain under privacy rules; cross-border fees for Philippine holders; on-chain record is only the manifest root and payment proofs. | Wholesale Australian investors, if counsel prefers fiat distributions. |
| ADA | No third party. | Price swings make "yield" unpredictable. | Not recommended for income. |

No AUD stablecoin was found on Cardano as of 27 Oct 2026 (AUDD runs on Stellar,
the XRP Ledger and Solana).

Questions for counsel before choosing: whether paying distributions in TSRA or
a USD stablecoin changes how the fractions are characterised; withholding-tax
handling per holder; and whether holders may elect their payout asset.

## 10. Out of scope for v2

- On-chain claim script (Build Guide 15.2; uses the same `manifest_root`).
- Transfer-restricted fraction policy (CIP-113 style), only if counsel requires.
- Debt-like offerings (Build Guide 15.5).
- Any change to Tessera scripts.
