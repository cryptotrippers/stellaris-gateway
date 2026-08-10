/**
 * Stage 4 — depositor-side smart contract paths for the shared yield vault.
 *
 * Two on-chain actions live here, both spending the vault's single State UTxO
 * so the validator's accounting branch runs:
 *
 *   Deposit  — adds lovelace as a new Position UTxO and mints shares at the
 *              current price. `total_shares`/`total_assets` move together.
 *   Withdraw — burns shares from one of the caller's Position UTxOs and pays
 *              the redeemed lovelace back to the owner's key-hash address.
 *
 * Every number here mirrors `contracts/vault/lib/stellaris/shares.ak`. The
 * validator re-derives all of it; this module only builds a transaction that
 * can satisfy it, and fails early with a readable message when it cannot.
 *
 * Browser-only: Lucid is dynamically imported and a CIP-30 wallet on the app's
 * network must be connected.
 */

import { checkVaultPreconditions, initLucidWithWallet } from "./vault";
import {
  assertReceiptPolicy,
  getReceiptPolicy,
  getYieldVaultScript,
  type AppliedReceiptPolicy,
} from "./yield-vault";
import {
  readPositionDatum,
  readStateDatum,
  type VaultPositionDatum,
  type VaultStateDatum,
} from "./yield-chain-decode";

/** YieldRedeemer constructor indices — mirrors yield_vault.ak. */
const REDEEMER_DEPOSIT = 0;
const REDEEMER_WITHDRAW = 1;

/** shares.ak constants. */
export const MIN_INITIAL_DEPOSIT = 10_000_000n;
export const MIN_POSITION_VALUE = 2_000_000n;
/** Headroom kept on the State UTxO so it always satisfies min-ADA. */
const STATE_MIN_LOVELACE = 2_000_000n;

export interface MyPosition {
  txHash: string;
  outputIndex: number;
  owner: string;
  shares: bigint;
  lovelace: bigint;
  /** Lovelace this position can redeem at the vault's current price. */
  redeemable: bigint;
}

export interface VaultView {
  address: string;
  state: VaultStateDatum;
  stateLovelace: bigint;
  sharePrice: number;
  positions: MyPosition[];
}

/** floor(deposit * total_shares / total_assets), 1:1 while the vault is empty. */
export function mintShares(state: VaultStateDatum, deposit: bigint): bigint {
  if (deposit <= 0n) return 0n;
  const shares = BigInt(state.totalShares);
  const assets = BigInt(state.totalAssets);
  if (shares <= 0n || assets <= 0n) return deposit;
  return (deposit * shares) / assets;
}

/** floor(shares * total_assets / total_shares), capped at the whole vault. */
export function redeemValue(state: VaultStateDatum, shares: bigint): bigint {
  const total = BigInt(state.totalShares);
  const assets = BigInt(state.totalAssets);
  if (shares <= 0n || total <= 0n) return 0n;
  if (shares >= total) return assets;
  return (shares * assets) / total;
}

function priceOf(state: VaultStateDatum): number {
  const shares = Number(state.totalShares);
  if (!shares) return 1;
  return Number(state.totalAssets) / shares;
}

interface LucidBits {
  lucid: Awaited<ReturnType<typeof initLucidWithWallet>>["lucid"];
  lucidMod: Awaited<ReturnType<typeof initLucidWithWallet>>["lucidMod"];
  script: ReturnType<typeof getYieldVaultScript>;
  receipt: AppliedReceiptPolicy;
  selfHash: string;
  walletAddress: string;
}

async function connect(assetId: string): Promise<LucidBits> {
  const pre = checkVaultPreconditions();
  if (!pre.ok) throw new Error(pre.reason);
  const { lucid, lucidMod } = await initLucidWithWallet();
  const script = getYieldVaultScript(lucidMod, assetId);
  const receipt = getReceiptPolicy(lucidMod, assetId);
  const walletAddress = await lucid.wallet().address();
  const cred = lucidMod.paymentCredentialOf(walletAddress);
  if (cred.type !== "Key") throw new Error("Connected address is not a key-hash address.");
  return { lucid, lucidMod, script, receipt, selfHash: cred.hash, walletAddress };
}

interface ResolvedUtxos {
  stateUtxo: { datum?: string | null; assets: Record<string, bigint> };
  state: VaultStateDatum;
  stateLovelace: bigint;
  positions: Array<{ utxo: unknown; datum: VaultPositionDatum; lovelace: bigint }>;
}

async function resolveVault(
  lucid: LucidBits["lucid"],
  address: string,
  owner?: string,
): Promise<ResolvedUtxos> {
  const utxos = await lucid.utxosAt(address);
  let stateUtxo: (typeof utxos)[number] | null = null;
  let state: VaultStateDatum | null = null;
  const positions: ResolvedUtxos["positions"] = [];

  for (const u of utxos) {
    const asState = readStateDatum(u.datum ?? null);
    if (asState) {
      if (state) throw new Error("More than one state UTxO found — refusing to build.");
      stateUtxo = u;
      state = asState;
      continue;
    }
    const asPosition = readPositionDatum(u.datum ?? null);
    if (asPosition && (!owner || asPosition.owner.toLowerCase() === owner.toLowerCase())) {
      positions.push({
        utxo: u,
        datum: asPosition,
        lovelace: (u.assets["lovelace"] as bigint | undefined) ?? 0n,
      });
    }
  }
  if (!stateUtxo || !state) {
    throw new Error("This vault has no state UTxO yet — it must be bootstrapped first.");
  }
  return {
    stateUtxo: stateUtxo as ResolvedUtxos["stateUtxo"],
    state,
    stateLovelace: (stateUtxo.assets["lovelace"] as bigint | undefined) ?? 0n,
    positions,
  };
}

function encodeState(
  lucidMod: LucidBits["lucidMod"],
  state: VaultStateDatum,
  next: { shares: bigint; assets: bigint; epoch?: number },
): string {
  const { Data, Constr } = lucidMod as unknown as {
    Data: { to: (v: unknown) => string };
    Constr: new (index: number, fields: unknown[]) => unknown;
  };
  // Deposits and redemptions never touch the fee terms; they are copied
  // through unchanged so the validator's continuity check passes.
  return Data.to(
    new Constr(1, [
      next.shares,
      next.assets,
      BigInt(next.epoch ?? state.epoch),
      state.operators.map((o) => o.toLowerCase()),
      BigInt(state.threshold),
      new Constr(state.paused ? 1 : 0, []),
      BigInt(state.feeBps),
      state.treasury,
      BigInt(state.treasuryShares),
      BigInt(state.lastFeeTime),
      state.receiptPolicy,
    ]),
  );
}

function encodePosition(lucidMod: LucidBits["lucidMod"], owner: string, shares: bigint): string {
  const { Data, Constr } = lucidMod as unknown as {
    Data: { to: (v: unknown) => string };
    Constr: new (index: number, fields: unknown[]) => unknown;
  };
  return Data.to(new Constr(0, [owner, shares]));
}

/** Read the vault plus the connected wallet's positions in it. */
export async function loadMyVaultView(assetId: string): Promise<VaultView> {
  const { lucid, script, selfHash } = await connect(assetId);
  const resolved = await resolveVault(lucid, script.address, selfHash);
  return {
    address: script.address,
    state: resolved.state,
    stateLovelace: resolved.stateLovelace,
    sharePrice: priceOf(resolved.state),
    positions: resolved.positions.map((p) => {
      const u = p.utxo as { txHash: string; outputIndex: number };
      return {
        txHash: u.txHash,
        outputIndex: u.outputIndex,
        owner: p.datum.owner,
        shares: BigInt(p.datum.shares),
        lovelace: p.lovelace,
        redeemable: redeemValue(resolved.state, BigInt(p.datum.shares)),
      };
    }),
  };
}

export interface DepositResult {
  txHash: string;
  address: string;
  depositLovelace: string;
  mintedShares: string;
  sharePrice: number;
}

/**
 * Deposit lovelace into the shared vault: spends the State UTxO, returns it
 * with the same lovelace and updated accounting, and creates a new Position
 * UTxO holding the deposit.
 */
export async function depositToYieldVault(params: {
  assetId: string;
  amountLovelace: bigint;
}): Promise<DepositResult> {
  const { lucid, lucidMod, script, receipt, selfHash } = await connect(params.assetId);
  const { stateUtxo, state, stateLovelace } = await resolveVault(lucid, script.address);
  assertReceiptPolicy(receipt, state.receiptPolicy);

  if (state.paused) {
    throw new Error("This vault is paused — deposits are closed until operators unpause it.");
  }
  const deposit = params.amountLovelace;
  const isBootstrapDeposit = BigInt(state.totalShares) <= 0n;
  if (isBootstrapDeposit && deposit < MIN_INITIAL_DEPOSIT) {
    throw new Error(
      `The first deposit into a vault must be at least ${Number(MIN_INITIAL_DEPOSIT) / 1e6} ADA.`,
    );
  }
  if (deposit < MIN_POSITION_VALUE) {
    throw new Error(
      `A position must hold at least ${Number(MIN_POSITION_VALUE) / 1e6} ADA to satisfy min-ADA.`,
    );
  }
  const minted = mintShares(state, deposit);
  if (minted <= 0n) {
    throw new Error("This deposit is too small to mint a share at the current price.");
  }

  const nextState = encodeState(lucidMod, state, {
    shares: BigInt(state.totalShares) + minted,
    assets: BigInt(state.totalAssets) + deposit,
  });
  const positionDatum = encodePosition(lucidMod, selfHash, minted);
  const { Data, Constr } = lucidMod as unknown as {
    Data: { to: (v: unknown) => string };
    Constr: new (index: number, fields: unknown[]) => unknown;
  };

  // Stage 6: the validator now requires receipts to be minted 1:1 with the
  // depositor shares created by this deposit.
  const mintRedeemer = Data.to(new Constr(0, []));

  // Per-asset opt-in: spend and mint through published reference scripts when
  // this vault has them; otherwise embed the CBOR exactly as before.
  const { spendRef, mintRef } = await refInputs(params.assetId, script, receipt);

  let builder = lucid.newTx();
  if (spendRef) builder = builder.readFrom([spendRef as never]);
  if (mintRef) builder = builder.readFrom([mintRef as never]);
  builder = builder.collectFrom([stateUtxo as never], Data.to(new Constr(REDEEMER_DEPOSIT, [])));
  if (!spendRef) {
    builder = builder.attach.SpendingValidator({ type: "PlutusV3", script: script.cbor });
  }
  builder = builder.mintAssets({ [receipt.unit]: minted }, mintRedeemer);
  if (!mintRef) {
    builder = builder.attach.MintingPolicy({ type: "PlutusV3", script: receipt.cbor });
  }
  const completed = await builder
    .pay.ToContract(script.address, { kind: "inline", value: nextState }, { lovelace: stateLovelace })
    .pay.ToContract(script.address, { kind: "inline", value: positionDatum }, { lovelace: deposit })
    .complete();

  const txHash = await (await completed.sign.withWallet().complete()).submit();
  return {
    txHash,
    address: script.address,
    depositLovelace: deposit.toString(),
    mintedShares: minted.toString(),
    sharePrice: priceOf(state),
  };
}

export interface WithdrawResult {
  txHash: string;
  address: string;
  burnedShares: string;
  paidLovelace: string;
  remainingShares: string;
}

/**
 * Redeem shares from one of the caller's positions. Spends the State UTxO and
 * that Position UTxO, pays the redeemed lovelace to the owner, and returns a
 * smaller position when the redemption is partial.
 *
 * Withdrawals stay available while the vault is paused, at the last price.
 */
export async function withdrawFromYieldVault(params: {
  assetId: string;
  /** Position to redeem from. Defaults to the caller's largest position. */
  positionTxHash?: string;
  positionOutputIndex?: number;
  /** Shares to burn. Defaults to the whole position (full close). */
  shares?: bigint;
}): Promise<WithdrawResult> {
  const { lucid, lucidMod, script, receipt, selfHash, walletAddress } = await connect(
    params.assetId,
  );
  const { stateUtxo, state, stateLovelace, positions } = await resolveVault(
    lucid,
    script.address,
    selfHash,
  );
  assertReceiptPolicy(receipt, state.receiptPolicy);
  if (positions.length === 0) {
    throw new Error("This wallet holds no position in this vault.");
  }

  const chosen =
    params.positionTxHash !== undefined
      ? positions.find((p) => {
          const u = p.utxo as { txHash: string; outputIndex: number };
          return (
            u.txHash === params.positionTxHash &&
            (params.positionOutputIndex === undefined ||
              u.outputIndex === params.positionOutputIndex)
          );
        })
      : positions.reduce((a, b) => (BigInt(b.datum.shares) > BigInt(a.datum.shares) ? b : a));
  if (!chosen) throw new Error("That position could not be found at the vault address.");

  const positionShares = BigInt(chosen.datum.shares);
  const shares = params.shares ?? positionShares;
  if (shares <= 0n) throw new Error("Enter a positive number of shares to redeem.");
  if (shares > positionShares) {
    throw new Error("That is more shares than this position holds.");
  }
  const remainingShares = positionShares - shares;

  // What the validator will allow: paid <= redeem_value(shares).
  const entitled = redeemValue(state, shares);
  if (entitled <= 0n) throw new Error("These shares currently redeem to zero lovelace.");

  const remainingPositionLovelace = remainingShares > 0n ? MIN_POSITION_VALUE : 0n;
  const availableToPay =
    stateLovelace + chosen.lovelace - remainingPositionLovelace - STATE_MIN_LOVELACE;
  if (availableToPay <= 0n) {
    throw new Error("The vault cannot cover this redemption without breaking its min-ADA floor.");
  }
  const paid = entitled < availableToPay ? entitled : availableToPay;
  if (remainingShares > 0n && redeemValue(state, remainingShares) < MIN_POSITION_VALUE) {
    throw new Error(
      "A partial redemption would leave a position below min-ADA — redeem the whole position instead.",
    );
  }

  const nextStateLovelace =
    stateLovelace + chosen.lovelace - paid - remainingPositionLovelace;
  const nextState = encodeState(lucidMod, state, {
    shares: BigInt(state.totalShares) - shares,
    assets: BigInt(state.totalAssets) - paid,
  });

  const { Data, Constr } = lucidMod as unknown as {
    Data: { to: (v: unknown) => string };
    Constr: new (index: number, fields: unknown[]) => unknown;
  };
  const redeemer = Data.to(new Constr(REDEEMER_WITHDRAW, [shares]));

  let builder = lucid
    .newTx()
    .collectFrom([stateUtxo as never, chosen.utxo as never], redeemer)
    .attach.SpendingValidator({ type: "PlutusV3", script: script.cbor })
    // Stage 6: redeeming shares burns exactly that many receipts.
    .mintAssets({ [receipt.unit]: -shares }, Data.to(new Constr(0, [])))
    .attach.MintingPolicy({ type: "PlutusV3", script: receipt.cbor })
    .pay.ToContract(
      script.address,
      { kind: "inline", value: nextState },
      { lovelace: nextStateLovelace },
    )
    // The validator requires an output paying the position's owner.
    .pay.ToAddress(walletAddress, { lovelace: paid })
    .addSignerKey(selfHash);

  if (remainingShares > 0n) {
    builder = builder.pay.ToContract(
      script.address,
      { kind: "inline", value: encodePosition(lucidMod, selfHash, remainingShares) },
      { lovelace: remainingPositionLovelace },
    );
  }

  const completed = await builder.complete();
  const txHash = await (await completed.sign.withWallet().complete()).submit();

  return {
    txHash,
    address: script.address,
    burnedShares: shares.toString(),
    paidLovelace: paid.toString(),
    remainingShares: remainingShares.toString(),
  };
}
