//// Stellaris per-user vault.
////
//// Datum records the owner's payment key hash.
//// Spending the UTxO succeeds iff the owner signs the transaction.
////
//// This is intentionally minimal for Phase 1 — no fractional token minting,
//// no yield claims, no timelock. Later phases will replace this with a
//// per-asset vault + fractional CIP-68 token.

use aiken/collection/list
use cardano/transaction.{OutputReference, Transaction}

pub type VaultDatum {
  owner: ByteArray,
}

validator vault {
  spend(
    datum: Option<VaultDatum>,
    _redeemer: Data,
    _own_ref: OutputReference,
    tx: Transaction,
  ) {
    expect Some(d) = datum
    list.has(tx.extra_signatories, d.owner)
  }

  else(_) {
    fail
  }
}
