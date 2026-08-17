//// USDr — test stablecoin minting policy (Preprod stand-in ONLY).
////
//// The real USDr is RealFi's product; this policy exists so the sUSDr vault
//// can be built and tested on Preprod before RealFi's own identifiers are
//// available. It is a simple admin-signed mint/burn policy — deliberately
//// centralized, exactly like a fiat-backed issuer, and NOT suitable for
//// anything beyond testing.
////
//// Parameterized by the issuer's payment key hash so different test
//// deployments can never collide.

use aiken/collection/list
use cardano/transaction.{Transaction}

validator usdr(issuer: ByteArray) {
  mint(_redeemer: Data, _policy_id: ByteArray, tx: Transaction) {
    // Any mint or burn under this policy requires the issuer's signature.
    list.has(tx.extra_signatories, issuer)
  }

  else(_) {
    fail
  }
}

// ------------------------------------------------------------------ tests

const t_issuer: ByteArray = #"00000000000000000000000000000000000000000000000000000001"

const t_stranger: ByteArray =
  #"00000000000000000000000000000000000000000000000000000002"

test issuer_can_mint() {
  let tx = Transaction { ..transaction.placeholder, extra_signatories: [t_issuer] }
  usdr.mint(t_issuer, Void, #"aabb", tx)
}

test stranger_cannot_mint() {
  let tx =
    Transaction { ..transaction.placeholder, extra_signatories: [t_stranger] }
  !usdr.mint(t_issuer, Void, #"aabb", tx)
}

test unsigned_mint_is_rejected() {
  let tx = Transaction { ..transaction.placeholder, extra_signatories: [] }
  !usdr.mint(t_issuer, Void, #"aabb", tx)
}
