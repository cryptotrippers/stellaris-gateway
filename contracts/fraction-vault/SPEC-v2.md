# `fraction_vault` v2 — specification (E05)

Status: **approved** (PR #29, 28 Oct 2026). **E06 built** on branch
`sprint3/fraction-v2-contracts`: `validators/offering_v2.ak`, `validators/pledge.ak`,
`validators/fraction_v2.ak`, shared types in `lib/stellaris/fv2.ak`, whole-transaction
tests in `validators/fv2_scenarios.ak`. Section 11 records where the scripts refine
this text. E07 (builders and tracker) and E09 (snapshot, manifest and payouts) are next.

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

## 11. E06 implementation notes (28 Oct 2026)

What the scripts do where this spec left a choice open, or where review of the
draft found a gap. Each item is covered by named tests in
`validators/fv2_scenarios.ak`.

### 11.1 Script wiring

| Script | Parameters as built | Why |
| --- | --- | --- |
| `offering_v2` | `version, asset_id, unit_policy, unit_name, pledge_hash, seed` | Needs the pledge script's hash to find pledge inputs in `Settle` and to refuse them in every other action. |
| `pledge` | `version` only (one script for every offering) | Taking `offering_hash` as section 3 proposed would make the two hashes depend on each other. The pledge datum names its offering instead (the State's thread-token policy), and one reference script serves all offerings. |
| `fraction_v2` | `offering_hash, asset_id` | As specified. It also requires the State's `fraction_policy` to be itself. |

The fraction policy named in the datum cannot be checked on-chain at `Open`
(a script cannot hash another script). As in v1, the reader that pins an offering
(`genuineOfferingAt`, E07) must check `fraction_policy == fraction_v2(offering_hash,
asset_id)` before the app lists it.

### 11.2 Pledges carry a marker (AUDIT.md F-4 pattern)

Paying to a script runs no code, so a pledge's `created` field and its deposit
cannot be trusted on their own. The pledge script is therefore also a minting
policy: `MintPledge` mints one `pledge` marker into one new pledge, only while the
offering (read as a reference input carrying its thread token) is `Raising`, only
if the transaction ends by the deadline, only for exactly `qty × price` units plus
a rider, to a key-address owner, and with `created` equal to the transaction's
lower bound. Every marked pledge that is spent burns its marker (`BurnPledges`
checks the count). Consequences:

* "Created after the deadline" and "wrong amount" can no longer occur for a
  marked pledge; they are refused at mint.
* A UTxO at the pledge address without a marker is not a pledge. `Settle` refuses
  it; anyone may return it to the owner its datum names, at any time
  (section 4.2's "malformed pledge" rule).

### 11.3 Refund and cancel payouts

`CancelPledge` and `RefundPledge` carry `out_ix`: that output must pay the owner
everything the pledge held (less the marker) and carry this pledge's own output
reference as its inline datum. The tag makes each payout belong to one pledge, so
two pledges of one owner cannot be refunded with a single payment
(double satisfaction). Many pledges can still be refunded in one transaction.

`RefundPledge` is allowed once the State is in **any** status other than
`Raising` (section 5.1 said `Refunding` or `Closed`). This also covers a pledge
left unsettled when the raise closed: its owner gets it back at once instead of
waiting for the settle window to end. The after-the-window rule still applies
while `Raising`.

### 11.4 Settle

* Who: the `keeper` key (in the terms) or the committee M-of-N.
* Layout: the new State is output 0; outputs 1..N pay each pledge's owner, in the
  order the pledges appear among the transaction's inputs (ledger order). Each
  owner output must go to the owner's exact address with exactly that pledge's
  fractions and at least the pledge's lovelace rider.
* Eligibility (when `eligibility_policy` is set): a reference input holds exactly
  one eligibility token named by the owner's key hash. No owner signature is
  needed, because the fractions can only go to the owner.
* Batch size: **15 pledges per Settle.** Every pledge script searches the
  transaction's inputs for the State, and the ledger orders inputs by
  transaction id, so the cost depends on where the State lands. With the State
  last (the worst order) 15 pledges use 75.6% of the per-transaction memory
  limit and 40.5% of CPU; 16 use 81.4%, and 20 would use 105.9%, over the
  limit. In the best order 20 use 77.6%. The gate
  (`scripts/contracts/fv2-budget-report.mjs`, run in CI) reads the worst-order
  tests (`settle_worst_cost_N`) and fails if 15 stops leaving 20% headroom. On
  Lucid's emulator, with real serialised transactions and reference scripts,
  20 pledges measured between 72.6% and 86% of memory over three random
  orders, consistent with these bounds. About 50 investors settle in four
  batches. (E06 first stated 20, measured in the best order only; corrected in
  E07, 29 Oct 2026.)

### 11.5 State datum layout

`OfferingV2 { status, terms, book, fee_bps, period, manifest_root, committee,
threshold }`:

* `Terms` holds every immutable field of section 4.1, plus `issuer` (signs `Open`),
  `keeper`, and the deposit unit (`unit_policy`, `unit_name`, equal to the script
  parameters, so a pledge can read them). Invariant 6 is one equality: `terms`
  unchanged.
* `Book` holds `settled, outstanding, escrowed, released, fees, pool,
  net_proceeds`. `net_proceeds` is recorded by `CloseRaise`
  (`escrowed − fees`), so the release cap is `net_proceeds − retained`.
* Each redeemer states the one next datum it allows as an update of the old one.
  A field it does not name cannot change.

### 11.6 Rules every State spend checks

* The State is output 0, alone at the script, at the spent State's exact address
  with no reference script (F-6), carrying the thread token, lovelace and the
  deposit unit only, with a rider.
* The State holds **exactly** `escrowed − released + pool` deposit units after
  every transaction (invariant 4 as an equality, so units cannot be added or
  taken outside the bookkeeping).
* Under `fraction_policy` exactly `Δoutstanding` of the asset id is minted or
  burned, and nothing else (invariant 3). `fraction_v2` checks the same from
  its side.
* `escrowed − released − fees ≥ 0` and `outstanding ≤ settled ≤ total_fractions`.
* No pledge input unless the action is `Settle`.

`BeginWindDown` leaves `escrowed = released + fees`, so unclaimed fees stay
claimable by the treasury and everything else (unreleased escrow, the retained
amount and the sale proceeds) joins the holders' pool.

### 11.7 Test evidence

* Whole-transaction harness: `run` executes every script a transaction would
  trigger (State spend, each pledge spend, each minting policy present) and
  accepts only if all accept. Every attack in section 8 is a small change to an
  accepted base transaction, and the base is tested too.
* Counts: 231 v2 tests (225 whole-transaction and single-script scenarios, 6 library
  unit tests) beside the 68 v1 tests; 173 of the scenarios are attacks.
* Harness check: with all three scripts replaced by `True`, all 162 attack
  transactions that go through the harness are accepted. So each rejection comes
  from a script, not from a malformed fixture. The other 11 attacks call one script
  directly ("each script on its own"), each beside an accepted control.
* Script sizes: `offering_v2` 8,117 B, `pledge` 4,423 B, `fraction_v2` 1,470 B
  (all under 13,000).
* Mutation pass: see 11.8.
* Not yet: Lucid emulator runs on serialised transactions (E07, with the
  builders), which also re-measure the Settle budget.

### 11.8 Mutation pass

Tool: `scripts/contracts/mutate-fv2.py` (resumable). It drops each conjunct of every
`and { }` block, flips each comparison (`==`/`!=`, `<`/`<=`, `>`/`>=`), swaps `&&`/`||`
and `+`/`-`, flips `True`/`False` and removes each `!`, in `offering_v2.ak`, `pledge.ak`,
`fraction_v2.ak` and `lib/stellaris/fv2.ak`. Each mutant runs the test group
nearest the change first and stops at the first failing test.

**324 mutants generated. 293 killed, 31 equivalent, 0 open.** (The run recorded
320; four mutants on a line that already had the same kind of mutation were skipped
by the resume key. The last four kills came from tests added after the run and
were each checked by re-applying the mutant.)

The pass found about 40 test gaps, all now closed by named tests. **None was a
contract bug.** The ones that mattered most:

* `CloseRaise` after a cancelled raise: without the status check, a committee
  could turn a refunding offering back into an operating one and release escrow
  owed to holders (`close_after_a_cancelled_raise_is_rejected`).
* Negative `Redeem` after some holders redeemed: it would mint fractions back for
  free (`redeem_of_a_negative_quantity_after_redemptions_is_rejected`).
* Negative `final_pool` at `BeginWindDown`: it would take escrow out of the State
  (`begin_wind_down_cannot_take_units_out`).
* Releases after earlier releases eating into the D-7 hold-back
  (`release_after_earlier_releases_cannot_eat_the_retained_amount`).
* A spare pledge marker minted to another wallet, or kept on cancel, which could
  later be planted in a forged pledge.
* The fixture had computed the State's balance and fees with the library's own
  functions, which hid mutations in them. It now computes both itself.

**Equivalent mutants (31).** Each one cannot change what the scripts accept, for
the reason given:

| Kind | Mutants | Why no transaction can tell them apart |
| --- | --- | --- |
| Double guard: another check refuses the same state | `offering_v2`: `RefundFraction qty > 0` dropped (`outstanding <= settled`); `ClaimFee amount <= fees` dropped (`fees >= 0`). `fv2.book_ok`: `settled >= 0` (`0 <= outstanding <= settled`), `fees >= 0` (`amount <= fees`), `outstanding <= settled` (`qty > 0` on every burn or mint), `pool >= 0` (pro-rata share is at most the pool; `final_pool >= 0`), `released >= 0` (`amount > 0`), escrow cover dropped or its signs flipped (x3: the release cap, the fee cap and the refund price each keep it). `fv2.terms_ok`: `total_fractions > 0` dropped or loosened (x2: `0 < soft_cap <= total_fractions`) | The state the check refuses is already refused by the named check. Kept as defence in depth. |
| Zero is a no-op | `Release amount > 0`, `ClaimFee amount > 0`, `RefundFraction qty > 0`, `Redeem qty > 0`, each loosened to `>= 0` | An amount or quantity of 0 gives a next State equal to the old one and moves nothing. |
| Same value at the boundary | `bps_of` (x3: `amount <= 0` → `< 0`, `bps <= 0` → `< 0`, `||` → `&&`); `pro_rata` (x3: `pool`, `qty`, `outstanding` `<= 0` → `< 0`) | At 0 the formula's own result is 0 as well (for `outstanding = 0`, the `qty > outstanding` guard returns 0 first). |
| Cannot be built on the ledger | `Open`: "no State input" dropped (the seed can be spent only once, so a second opening cannot run); `BurnPledges marked > 0` dropped or loosened (x2) and `fraction_v2 delta != 0` dropped (a mint never lists a zero quantity); `SettlePledge` State check `&&` → `||` (an input at the offering address without the thread token cannot be spent at all) | The distinguishing transaction is not a valid Cardano transaction. |
| Implied by a stronger check | `offering_v2`: `at(out, own)` (`continuing_ok` compares the full address); `n.terms == t` (every action compares the whole next datum). `pledge`: `holds_marker(out)` at mint (the clean-value check on the value less one marker refuses a missing marker); `CancelPledge marked` (an unmarked UTxO may be returned to its owner by anyone anyway) | The stronger check makes the same decision. |

### 11.9 Known limitation: ADA as the deposit unit

For an ADA unit the State must hold exactly `2 ADA + (escrowed − released +
pool)` lovelace (`units_in` subtracts a fixed 2 ADA rider). The State datum is
about 400 bytes, so the ledger's minimum ADA for it is above 3 ADA, and a fresh
State (balance 0) cannot be created: an ADA-denominated offering cannot be
opened. Native-token units (TSRA on Preprod, any stablecoin on mainnet) are not
affected, because their rider is separate from the balance and the builders set
it to 5 ADA. The builders refuse an ADA unit with a clear message. A fix (a
rider recorded in the datum) is a contract change for the second audit, only if
an ADA-denominated offering is ever wanted. Found by the E07 emulator run.

## 12. E07 off-chain (29 Oct 2026)

| Module | What |
| --- | --- |
| `src/lib/fraction-vault-v2.ts` | Pins the three unapplied blueprints (checked by `verify-vault-hash` in CI), derives pledge → offering → fraction policy, registers each with the S1 trust view, and `fractionPolicyIsGenuine` (§11.1). |
| `src/lib/offering-v2-chain.ts` | The single encoder and strict decoder for the State and pledge datums and every redeemer; next-State rules mirroring `offering_v2`, refusing early with a readable reason. `KEEPER_BATCH = 15`. |
| `src/lib/offering-v2-tx.ts` | Builders for every action in §7: open, pledge, cancel, refund (batch), settle (≤ 15), close, fail, cancel raise, refund fraction, release, commit period, set fees, claim fee, rotate, begin wind-down, redeem, publish reference scripts. Each returns the unsigned transaction and its S1 intent; nothing signs. |
| `src/lib/tx-tracker.shared.ts` | Follows a submitted transaction: pending → on chain → final (15 blocks), with rollbacks reported and counted, and expiry once its validity window closes. Reads `/txs/{hash}` and `/blocks/latest` through the E13 proxy (two read-only rules added). |

Evidence, on Lucid's emulator with the real compiled scripts, every
transaction checked by `assertIntent` before signing:

* Full success path (open, two settle batches, close, release, commit period,
  claim fee, wind down, redeem) and failure path (cancel, fail, refund pledge,
  refund fraction to Closed): `tests/contracts/fv2-emulator.test.ts`.
* Seven hand-built attacks refused by the real UPLC, each beside its honest
  control: `tests/contracts/fv2-emulator-attacks.test.ts`.
* Settle of 15 with reference scripts: 52.9% memory, 27.4% CPU, 3,091 bytes in
  the measured order; the worst order is bounded by the Aiken gate (§11.4).
* Findings: the State needs a 5 ADA rider (its datum's min-ADA is above 3 ADA;
  the guard caught the builder's 2 ADA); release and claim payouts carry a 2 ADA
  rider from the signing wallet, now declared in the intent; §11.4's batch size
  corrected to 15; §11.9's ADA-unit limitation.

Not in E07: the app UI (Lovable), a keeper service that runs `buildSettle` on
a schedule, a Preprod bootstrap, and E09 (snapshot, manifest, payouts).

## 13. Preprod test offering and keeper (30–31 Oct 2026)

**Test offering.** `fv2-test-01` (TSRA, 1,000 fractions at 10 TSRA, soft cap
100, 1% fee, 2-of-3 committee) was opened on Preprod and taken through its whole
ordinary life by `scripts/fv2/smoke-test.ts`: three pledges, a Settle, CloseRaise,
Release, CommitPeriod 1 and ClaimFee. End State: `operating`, holding 939.5 TSRA,
equal to its books. Record: `deployments/fv2-preprod-test.json`. Found there:
Blockfrost confirms a transaction before its script-address index moves, so
every operator script waits until the transaction's own output is visible before
reading the chain again.

**Keeper** (`src/lib/offering-v2-keeper.ts`, operator script `scripts/fv2/keeper.ts`).
A pure planner reads one snapshot (State, pledges, time) and lists every job
legal now; the runner does one job, waits until the chain shows it, and plans
again, so a crash, a rollback or a rival only means the next plan starts from
the chain.

| Job | When | Who may | Rule it follows |
| --- | --- | --- | --- |
| Settle | `Raising`, ≥ 10 min before deadline + settle window | keeper key only (the committee settles by hand) | marked pledges, first come first served (by `created`), ≤ 15 per tx, never past the hard cap: a pledge that does not fit is skipped and later smaller ones still settle |
| FailRaise | `Raising`, validity start past deadline + window, `settled < soft_cap` | anyone | the refunds follow on the next plan |
| Refund | not `Raising`, or `Raising` past the window | anyone | marked pledges the raise can no longer take, ≤ 15 per tx, each to its owner |
| Return strays | any time, only with `--return-strays` | anyone | unmarked UTxOs naming the offering, to their datum's owner; opt-in because anyone can create them and the keeper pays the fees |

It never signs a committee action; it prints when one is due (CloseRaise after
the deadline with the soft cap met, or after the window). Offerings with an
eligibility policy are not settled unless an eligibility source is supplied.

Refund batch: 15 refunds with reference scripts measured 45–46% of memory, 22%
of CPU and 3.3 kB on the emulator (each refund's pledge run reads the State as a
reference input, so input order does not change its search).

Evidence: `src/lib/offering-v2-keeper.test.ts` (planner rules, 17 tests) and
`tests/contracts/fv2-keeper.test.ts` (emulator, real scripts): 19 pledges settled
15 + 4 with a hard-cap overflow refunded after close; a failed raise with 17
pledges returned 15 + 2 by a wallet that is not the keeper; a forged unmarked
pledge never settled; a Settle by a stranger refused; a rival settling first;
a look-alike State without the thread token ignored.

Where it runs: on the operator's PC (`--submit --watch`). Running it unattended
elsewhere (a scheduled job holding the keeper key) is a deployment decision
for later and needs approval.
