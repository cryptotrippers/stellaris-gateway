//// The yield vault's datum, shared by `validators/yield_vault.ak` and
//// `validators/receipt.ak`.
////
//// It lives in a lib module so both validators compile against ONE
//// definition. `receipt.ak` previously kept a hand-copied 11-field mirror
//// that silently fell behind when Stage 7 added the entry/exit fee fields,
//// so every receipt mint crashed on a real 13-field State (AUDIT.md F-2).

pub type YieldDatum {
  /// A single depositor's stake.
  Position { owner: ByteArray, shares: Int }
  /// The vault's aggregate ledger. Exactly one per vault, identified on-chain
  /// by the state-thread token it carries (see `stellaris/thread`).
  ///
  /// Fee fields (Stage 5): the management fee is an annual rate in basis
  /// points charged on accounted assets, prorated by wall-clock time and
  /// settled by MINTING shares to the treasury rather than paying lovelace
  /// out. `treasury_shares` is the treasury's unclaimed slice of
  /// `total_shares`; `last_fee_time` is the POSIX ms up to which fee has
  /// already been charged.
  State {
    total_shares: Int,
    total_assets: Int,
    epoch: Int,
    operators: List<ByteArray>,
    threshold: Int,
    paused: Bool,
    fee_bps: Int,
    treasury: ByteArray,
    treasury_shares: Int,
    last_fee_time: Int,
    /// Stage 6: the receipt minting policy bound to this vault, written once
    /// at bootstrap and immutable afterwards. Every `Deposit` must mint, and
    /// every `Withdraw` must burn, exactly the depositor-share delta under
    /// this policy with token name = `asset_id`; every other action must move
    /// zero receipts. Must be a 28-byte script hash.
    receipt_policy: ByteArray,
    /// Stage 7 (revenue): per-action fees, in basis points, charged on the
    /// deposited amount and on the gross redemption respectively. The
    /// withheld lovelace never leaves the vault — it is credited to the
    /// treasury as shares, exactly like the management fee. Both start at 0
    /// at bootstrap and can only move through `SetFee`, within the caps in
    /// `stellaris/shares`.
    entry_fee_bps: Int,
    exit_fee_bps: Int,
  }
}
