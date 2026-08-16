/**
 * Depositor-side smart contract paths for the sUSDr vault: mirrors
 * `yield-position.ts`'s structure, with USDr (a native token) as the
 * accounted currency instead of lovelace.
 *
 * Two on-chain actions live here, both spending the vault's single State
 * UTxO so the validator's accounting branch runs:
 *
 *   Deposit  — adds USDr as a new Position UTxO and mints sUSDr shares at
 *              the current price. `total_shares`/`total_assets` move together.
 *   Withdraw — burns shares from one of the caller's Position UTxOs and pays
 *              the redeemed USDr back to the owner's key-hash address.
 *
 * IMPORTANT — lovelace vs. USDr are handled differently here than in
 * `yield-position.ts`, because USDr (not lovelace) is now the accounted
 * currency:
 *   - Every UTxO this module creates still needs *some* lovelace, purely to
 *     satisfy Cardano's ledger-enforced min-UTxO-ADA rule (see DESIGN.md,
 *     "min-UTxO-ADA is a ledger rule"). That lovelace is NOT vault money and
 *     is never part of the accounting deltas below — it is supplied by the
 *     connected wallet's own balance via Lucid's normal coin selection.
 *   - The State UTxO's own USDr balance acts as a reserve: on `Withdraw`,
 *     any USDr left over after paying the owner and topping up a surviving
 *     Position to its dust floor flows into State's own balance rather than
 *     staying physically inside that Position (the Position's `shares`
 *     count is what tracks its claim — this mirrors `yield-position.ts`'s
 *     own withdraw logic, which does the identical thing with lovelace).
 *
 * Browser-only: Lucid is dynamically imported and a CIP-30 wallet on the
 * app's network must be connected.
 */

import { checkVaultPreconditions, initLucidWithWallet } from "./vault";
import { assertSusdrVaultAddress, getSusdrVaultScript, type AppliedSusdrVault } from "./susdr-vault";
import {
  encodeStateDatum,
  encodePositionDatum,
  readPositionDatum,
  readStateDatum,
  selectCanonicalState,
  type SusdrPositionDatum,
  type SusdrStateDatum,
} from "./susdr-chain-decode";

/** SusdrRedeemer constructor indices — mirrors susdr_vault.ak. */
const REDEEMER_DEPOSIT = 0;
const REDEEMER_WITHDRAW = 1;

/** shares.ak constants, reinterpreted as USDr base units — see DESIGN.md's decimals note. */
export const MIN_INITIAL_DEPOSIT = 10_000_000n;
export const MIN_POSITION_VALUE = 2_000_000n;

/** Fixed lovelace floor placed on every vault-owned UTxO, purely for min-ADA. */
const UTXO_MIN_LOVELACE = 2_000_000n;

export interface MyPosition {
  txHash: string;
  outputIndex: number;
  owner: string;
  shares: bigint;
  usdr: bigint;
  /** USDr this position can redeem at the vault's current price. */
  redeemable: bigint;
}

export interface VaultView {
  address: string;
  state: SusdrStateDatum;
  stateUsdr: bigint;
  sharePrice: number;
  positions: MyPosition[];
}

/** floor(deposit * total_shares / total_assets), 1:1 while the vault is empty. */
export function mintShares(state: SusdrStateDatum, deposit: bigint): bigint {
  if (deposit <= 0n) return 0n;
  const shares = BigInt(state.totalShares);
  const assets = BigInt(state.totalAssets);
  if (shares <= 0n || assets <= 0n) return deposit;
  return (deposit * shares) / assets;
}

/** floor(shares * total_assets / total_shares), capped at the whole vault. */
export function redeemValue(state: SusdrStateDatum, shares: bigint): bigint {
  const total = BigInt(state.totalShares);
  const assets = BigInt(state.totalAssets);
  if (shares <= 0n || total <= 0n) return 0n;
  if (shares >= total) return assets;
  return (shares * assets) / total;
}

function priceOf(state: SusdrStateDatum): number {
  const shares = Number(state.totalShares);
  if (!shares) return 1;
  return Number(state.totalAssets) / shares;
}

interface LucidBits {
  lucid: Awaited<ReturnType<typeof initLucidWithWallet>>["lucid"];
  lucidMod: Awaited<ReturnType<typeof initLucidWithWallet>>["lucidMod"];
  script: AppliedSusdrVault;
  selfHash: string;
  walletAddress: string;
}

async function connect(usdrPolicyId: string, registryAddress?: string | null): Promise<LucidBits> {
  const pre = checkVaultPreconditions();
  if (!pre.ok) throw new Error(pre.reason);
  const { lucid, lucidMod } = await initLucidWithWallet();
  const script = getSusdrVaultScript(lucidMod, usdrPolicyId);
  assertSusdrVaultAddress(script, registryAddress);
  const walletAddress = await lucid.wallet().address();
  const cred = lucidMod.paymentCredentialOf(walletAddress);
  if (cred.type !== "Key") throw new Error("Connected address is not a key-hash address.");
  return { lucid, lucidMod, script, selfHash: cred.hash, walletAddress };
}

interface ResolvedUtxos {
  stateUtxo: { datum?: string | null; assets: Record<string, bigint> };
  state: SusdrStateDatum;
  stateUsdr: bigint;
  stateLovelace: bigint;
  positions: Array<{ utxo: unknown; datum: SusdrPositionDatum; usdr: bigint }>;
}

async function resolveVault(
  lucid: LucidBits["lucid"],
  address: string,
  script: AppliedSusdrVault,
  owner?: string,
): Promise<ResolvedUtxos> {
  const utxos = await lucid.utxosAt(address);
  const stateCandidates: Array<{ utxo: (typeof utxos)[number]; state: SusdrStateDatum }> = [];
  const positions: ResolvedUtxos["positions"] = [];
  const usdrUnit = `${script.usdrPolicyId}${script.usdrAssetNameHex}`;

  for (const u of utxos) {
    const asState = readStateDatum(u.datum ?? null);
    if (asState) {
      stateCandidates.push({ utxo: u, state: asState });
      continue;
    }
    const asPosition = readPositionDatum(u.datum ?? null);
    if (asPosition && (!owner || asPosition.owner.toLowerCase() === owner.toLowerCase())) {
      positions.push({
        utxo: u,
        datum: asPosition,
        usdr: (u.assets[usdrUnit] as bigint | undefined) ?? 0n,
      });
    }
  }
  const chosen = selectCanonicalState(stateCandidates, (c) => ({
    txHash: c.utxo.txHash,
    outputIndex: c.utxo.outputIndex,
    state: c.state,
  }));
  const stateUtxo = chosen?.utxo ?? null;
  const state = chosen?.state ?? null;
  if (!stateUtxo || !state) {
    throw new Error("This vault has no state UTxO yet — it must be bootstrapped first.");
  }

  return {
    stateUtxo: stateUtxo as ResolvedUtxos["stateUtxo"],
    state,
    stateUsdr: (stateUtxo.assets[usdrUnit] as bigint | undefined) ?? 0n,
    stateLovelace: (stateUtxo.assets["lovelace"] as bigint | undefined) ?? 0n,
    positions,
  };
}

function encodeState(
  lucidMod: LucidBits["lucidMod"],
  state: SusdrStateDatum,
  next: { shares: bigint; assets: bigint; epoch?: number },
): string {
  // Deposits and redemptions never touch the fee terms; copied through
  // unchanged so the validator's continuity check passes.
  return encodeStateDatum(lucidMod, {
    ...state,
    totalShares: next.shares.toString(),
    totalAssets: next.assets.toString(),
    epoch: next.epoch ?? state.epoch,
  });
}

/** Read the vault plus the connected wallet's positions in it. */
export async function loadMyVaultView(
  usdrPolicyId: string,
  registryAddress?: string | null,
): Promise<VaultView> {
  const { lucid, script, selfHash } = await connect(usdrPolicyId, registryAddress);
  const resolved = await resolveVault(lucid, script.address, script, selfHash);
  return {
    address: script.address,
    state: resolved.state,
    stateUsdr: resolved.stateUsdr,
    sharePrice: priceOf(resolved.state),
    positions: resolved.positions.map((p) => {
      const u = p.utxo as { txHash: string; outputIndex: number };
      return {
        txHash: u.txHash,
        outputIndex: u.outputIndex,
        owner: p.datum.owner,
        shares: BigInt(p.datum.shares),
        usdr: p.usdr,
        redeemable: redeemValue(resolved.state, BigInt(p.datum.shares)),
      };
    }),
  };
}

export interface DepositResult {
  txHash: string;
  address: string;
  depositUsdr: string;
  mintedShares: string;
  sharePrice: number;
}

/**
 * Deposit USDr into the shared vault: spends the State UTxO, returns it with
 * the same balances and updated accounting, and creates a new Position UTxO
 * holding the deposit plus the sUSDr mint.
 */
export async function depositToSusdrVault(params: {
  usdrPolicyId: string;
  amountUsdr: bigint;
  registryAddress?: string | null;
}): Promise<DepositResult> {
  const { lucid, lucidMod, script, selfHash } = await connect(params.usdrPolicyId, params.registryAddress);
  const { stateUtxo, state, stateLovelace, stateUsdr } = await resolveVault(
    lucid,
    script.address,
    script,
  );

  if (state.paused) {
    throw new Error("This vault is paused — deposits are closed until operators unpause it.");
  }
  const deposit = params.amountUsdr;
  const isBootstrapDeposit = BigInt(state.totalShares) <= 0n;
  if (isBootstrapDeposit && deposit < MIN_INITIAL_DEPOSIT) {
    throw new Error(
      `The first deposit into a vault must be at least ${Number(MIN_INITIAL_DEPOSIT) / 1e6} USDr.`,
    );
  }
  if (deposit < MIN_POSITION_VALUE) {
    throw new Error(`A position must hold at least ${Number(MIN_POSITION_VALUE) / 1e6} USDr.`);
  }
  const minted = mintShares(state, deposit);
  if (minted <= 0n) {
    throw new Error("This deposit is too small to mint a share at the current price.");
  }

  const nextState = encodeState(lucidMod, state, {
    shares: BigInt(state.totalShares) + minted,
    assets: BigInt(state.totalAssets) + deposit,
  });
  const positionDatum = encodePositionDatum(lucidMod, selfHash, minted);
  const { Data, Constr } = lucidMod as unknown as {
    Data: { to: (v: unknown) => string };
    Constr: new (index: number, fields: unknown[]) => unknown;
  };

  const depositRedeemer = Data.to(new Constr(REDEEMER_DEPOSIT, []));
  // The sUSDr mint runs the SAME script (spend and mint share one hash — see
  // DESIGN.md), so a single `attach.SpendingValidator` covers both purposes;
  // no separate minting-policy attachment is needed the way `receipt.ak`
  // required in `yield-position.ts`.
  const mintRedeemer = Data.to(new Constr(0, []));
  const usdrUnit = `${script.usdrPolicyId}${script.usdrAssetNameHex}`;

  const completed = await lucid
    .newTx()
    .collectFrom([stateUtxo as never], depositRedeemer)
    .attach.SpendingValidator({ type: "PlutusV3", script: script.cbor })
    .mintAssets({ [script.susdrUnit]: minted }, mintRedeemer)
    .pay.ToContract(
      script.address,
      { kind: "inline", value: nextState },
      { lovelace: stateLovelace, [usdrUnit]: stateUsdr },
    )
    .pay.ToContract(
      script.address,
      { kind: "inline", value: positionDatum },
      { lovelace: UTXO_MIN_LOVELACE, [usdrUnit]: deposit },
    )
    .complete();

  const txHash = await (await completed.sign.withWallet().complete()).submit();
  return {
    txHash,
    address: script.address,
    depositUsdr: deposit.toString(),
    mintedShares: minted.toString(),
    sharePrice: priceOf(state),
  };
}

export interface WithdrawResult {
  txHash: string;
  address: string;
  burnedShares: string;
  paidUsdr: string;
  remainingShares: string;
}

/**
 * Redeem shares from one of the caller's positions. Spends the State UTxO
 * and that Position UTxO, pays the redeemed USDr to the owner, and returns a
 * smaller position when the redemption is partial.
 *
 * Withdrawals stay available while the vault is paused, at the last price.
 */
export async function withdrawFromSusdrVault(params: {
  usdrPolicyId: string;
  /** Position to redeem from. Defaults to the caller's largest position. */
  positionTxHash?: string;
  positionOutputIndex?: number;
  /** Shares to burn. Defaults to the whole position (full close). */
  shares?: bigint;
  registryAddress?: string | null;
}): Promise<WithdrawResult> {
  const { lucid, lucidMod, script, selfHash, walletAddress } = await connect(
    params.usdrPolicyId,
    params.registryAddress,
  );
  const { stateUtxo, state, stateUsdr, stateLovelace, positions } = await resolveVault(
    lucid,
    script.address,
    script,
    selfHash,
  );
  if (positions.length === 0) {
    throw new Error("This wallet holds no position in this vault.");
  }

  const chosen =
    params.positionTxHash !== undefined
      ? positions.find((p) => {
          const u = p.utxo as { txHash: string; outputIndex: number };
          return (
            u.txHash === params.positionTxHash &&
            (params.positionOutputIndex === undefined || u.outputIndex === params.positionOutputIndex)
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

  const entitled = redeemValue(state, shares);
  if (entitled <= 0n) throw new Error("These shares currently redeem to zero USDr.");

  const remainingPositionUsdr = remainingShares > 0n ? MIN_POSITION_VALUE : 0n;
  const availableToPay = stateUsdr + chosen.usdr - remainingPositionUsdr;
  if (availableToPay <= 0n) {
    throw new Error("The vault cannot cover this redemption without stranding the surviving position below its dust floor.");
  }
  const paid = entitled < availableToPay ? entitled : availableToPay;
  if (remainingShares > 0n && redeemValue(state, remainingShares) < MIN_POSITION_VALUE) {
    throw new Error(
      "A partial redemption would leave a position below the dust floor — redeem the whole position instead.",
    );
  }

  // Residual USDr (state's own balance + what the spent position held, minus
  // the payout and whatever tops up a surviving position) flows into State's
  // own balance — see the module doc comment.
  const nextStateUsdr = stateUsdr + chosen.usdr - paid - remainingPositionUsdr;
  const nextState = encodeState(lucidMod, state, {
    shares: BigInt(state.totalShares) - shares,
    assets: BigInt(state.totalAssets) - paid,
  });

  const { Data, Constr } = lucidMod as unknown as {
    Data: { to: (v: unknown) => string };
    Constr: new (index: number, fields: unknown[]) => unknown;
  };
  const redeemer = Data.to(new Constr(REDEEMER_WITHDRAW, [shares]));
  const mintRedeemer = Data.to(new Constr(0, []));
  const usdrUnit = `${script.usdrPolicyId}${script.usdrAssetNameHex}`;

  let builder = lucid
    .newTx()
    .collectFrom([stateUtxo as never, chosen.utxo as never], redeemer)
    .attach.SpendingValidator({ type: "PlutusV3", script: script.cbor })
    .mintAssets({ [script.susdrUnit]: -shares }, mintRedeemer)
    .pay.ToContract(
      script.address,
      { kind: "inline", value: nextState },
      { lovelace: stateLovelace, [usdrUnit]: nextStateUsdr },
    )
    .pay.ToAddress(walletAddress, { lovelace: UTXO_MIN_LOVELACE, [usdrUnit]: paid })
    .addSignerKey(selfHash);

  if (remainingShares > 0n) {
    builder = builder.pay.ToContract(
      script.address,
      { kind: "inline", value: encodePositionDatum(lucidMod, selfHash, remainingShares) },
      { lovelace: UTXO_MIN_LOVELACE, [usdrUnit]: remainingPositionUsdr },
    );
  }

  const completed = await builder.complete();
  const txHash = await (await completed.sign.withWallet().complete()).submit();

  return {
    txHash,
    address: script.address,
    burnedShares: shares.toString(),
    paidUsdr: paid.toString(),
    remainingShares: remainingShares.toString(),
  };
}
