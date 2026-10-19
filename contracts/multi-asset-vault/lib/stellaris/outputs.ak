//// Output pinning for script UTxOs (AUDIT.md F-6).
////
//// Shared verbatim by every project under `contracts/` (like `thread.ak`):
//// the copies must stay byte-identical, and the verification script checks
//// that they do.
////
//// A validator that selects its UTxOs by payment credential alone lets a
//// transaction move a State, Position or Ticket to the same script under a
//// stake credential of the attacker's choosing (the attacker then earns the
//// staking rewards and can make the UTxO hard for off-chain code to find),
//// or attach a reference script that inflates its min-ADA. Each continuing
//// output therefore keeps the spent UTxO's exact address and carries no
//// reference script; each genesis output sits at the script's enterprise
//// address (no stake credential).

use cardano/address.{Address, Script}
use cardano/assets.{PolicyId, lovelace_of}
use cardano/transaction.{Output}

/// The enterprise address of a script: its own payment credential and no
/// stake credential. Where every genesis output lives.
pub fn script_address(hash: PolicyId) -> Address {
  Address { payment_credential: Script(hash), stake_credential: None }
}

/// A continuing output: the spent UTxO's full address (stake credential
/// included) and no reference script.
pub fn continuing_ok(out: Output, spent: Output) -> Bool {
  and {
    out.address == spent.address,
    out.reference_script == None,
  }
}

/// A genesis output: the script's enterprise address and no reference script.
pub fn genesis_out_ok(out: Output, hash: PolicyId) -> Bool {
  and {
    out.address == script_address(hash),
    out.reference_script == None,
  }
}

/// The continuing output keeps at least the spent UTxO's lovelace.
pub fn keeps_lovelace(out: Output, spent: Output) -> Bool {
  lovelace_of(out.value) >= lovelace_of(spent.value)
}
