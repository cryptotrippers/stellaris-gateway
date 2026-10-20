//// STUB (size measurement only).
use aiken/collection/pairs
use cardano/address.{Credential}
use cardano/assets.{PolicyId}
use cardano/certificate.{Certificate, RegisterCredential}
use cardano/transaction.{Transaction}
use tessera/queue_state.{AdminRedeemer}

validator queue_admin(reserve: PolicyId) {
  withdraw(redeemer: AdminRedeemer, account: Credential, tx: Transaction) {
    and {
      pairs.get_first(tx.withdrawals, account) == Some(0),
      redeemer.queue == reserve,
    }
  }

  publish(_r: Data, certificate: Certificate, _tx: Transaction) {
    when certificate is {
      RegisterCredential { .. } -> True
      _ -> False
    }
  }

  else(_) {
    fail
  }
}
