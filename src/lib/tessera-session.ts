/**
 * Browser glue for the Tessera actions: connect the CIP-30 wallet (Preprod
 * only), build with `tessera-tx.ts`, check with the S1 guard and the confirm
 * dialog (`signGuarded`), sign and submit. Lucid is dynamically imported by
 * `initLucidWithWallet`, so nothing here runs during server rendering.
 */
import { checkVaultPreconditions, initLucidWithWallet } from "./vault";
import { TESSERA_PREPROD_V1_DEPLOYMENT } from "./tessera-deployment";
import {
  assertPreprodWallet,
  buildClaim,
  buildInstant,
  buildRequest,
  buildRequestUnstake,
  buildSettle,
  buildStakeShort,
  requests,
  tickets,
  type TesseraCtx,
} from "./tessera-tx";
import { signGuarded } from "./tx-sign-guarded";

export const TESSERA_DEP = TESSERA_PREPROD_V1_DEPLOYMENT;

export type TesseraAction =
  | { kind: "stake"; amount: bigint }
  | { kind: "unstake"; shares: bigint }
  | { kind: "claim"; ticket: string }
  | { kind: "request"; qty: bigint }
  | { kind: "instant"; qty: bigint }
  | { kind: "settle"; requests: string[] };

async function session(): Promise<{ ctx: TesseraCtx; address: string }> {
  const pre = checkVaultPreconditions();
  if (!pre.ok) throw new Error(pre.reason);
  const { lucid, lucidMod } = await initLucidWithWallet();
  const address = await lucid.wallet().address();
  assertPreprodWallet(address);
  return { ctx: { lucid, L: lucidMod, dep: TESSERA_DEP }, address };
}

export interface WalletBalances {
  address: string;
  keyHash: string | null;
  tsra: bigint;
  stsra: bigint;
  tusd: bigint;
}

/** The connected wallet's bech32 address, key hash and Tessera balances. */
export async function loadWalletBalances(): Promise<WalletBalances> {
  const { ctx, address } = await session();
  const utxos = await ctx.lucid.wallet().getUtxos();
  const sum = (unit: string) => utxos.reduce((a, u) => a + (u.assets[unit] ?? 0n), 0n);
  const cred = ctx.L.getAddressDetails(address).paymentCredential;
  return {
    address,
    keyHash: cred?.type === "Key" ? cred.hash : null,
    tsra: sum(TESSERA_DEP.reserve.tsraUnit),
    stsra: sum(TESSERA_DEP.vault.stsraUnit),
    tusd: sum(TESSERA_DEP.payoutUnit),
  };
}

/** Build, guard, sign and submit one action. Returns the transaction hash. */
export async function runTesseraAction(
  a: TesseraAction,
): Promise<{ txHash: string; summary: Record<string, string> }> {
  const { ctx } = await session();
  const now = Date.now();
  let built;
  switch (a.kind) {
    case "stake":
      built = await buildStakeShort(ctx, a.amount, now);
      break;
    case "unstake":
      built = await buildRequestUnstake(ctx, a.shares, now);
      break;
    case "claim": {
      const t = (await tickets(ctx)).find(
        (x) => `${x.utxo.txHash}#${x.utxo.outputIndex}` === a.ticket,
      );
      if (!t) throw new Error("That Ticket is no longer on chain (already claimed?).");
      built = await buildClaim(ctx, t, now);
      break;
    }
    case "request":
      built = await buildRequest(ctx, a.qty, now);
      break;
    case "instant":
      built = await buildInstant(ctx, a.qty, now);
      break;
    case "settle": {
      const want = new Set(a.requests);
      const rs = (await requests(ctx)).filter((r) =>
        want.has(`${r.utxo.txHash}#${r.utxo.outputIndex}`),
      );
      if (rs.length === 0) throw new Error("Those Requests have already been settled.");
      built = await buildSettle(ctx, rs, now);
      break;
    }
  }
  const signed = await signGuarded(ctx.lucid, built.tx, built.intent);
  const txHash = await signed.submit();
  return { txHash, summary: built.summary };
}
