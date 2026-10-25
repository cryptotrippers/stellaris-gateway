/**
 * Security Suite S1 — the one door to the wallet.
 *
 * Every builder hands its completed transaction to `signGuarded` (or, for a
 * multi-signature draft, `partialSignGuarded`) instead of calling the
 * wallet's sign methods itself. The transaction is decoded and checked by the
 * intent guard first; the wallet is only asked to sign when nothing is wrong.
 * A source-scan test fails if any other file calls `sign.withWallet()` or
 * `partialSign.withWallet()` directly.
 *
 * Plain shared module: Lucid is imported dynamically, never at top level.
 */
import {
  TxIntentRejected,
  checkTx,
  decodeTx,
  summariseTx,
  type Assets,
  type DecodedTx,
  type TxIntent,
  type WalletView,
} from "./tx-intent-guard.shared";
import { trust, type TrustView } from "./tx-trust.shared";

interface UtxoLike {
  txHash: string;
  outputIndex: number;
  address: string;
  assets: Record<string, bigint>;
}

interface LucidLike {
  wallet(): { address(): Promise<string>; getUtxos(): Promise<UtxoLike[]> };
}

interface SignBuilderLike<Signed> {
  toCBOR(): string;
  sign: { withWallet(): { complete(): Promise<Signed> } };
  partialSign: { withWallet(): Promise<string> };
}

/**
 * Optional confirmation step (S1.6). The UI may register a handler that shows
 * the plain-English summary and resolves true to continue. No handler = no
 * dialog; the guard's checks still run.
 */
type ConfirmHandler = (action: string, lines: string[]) => Promise<boolean>;
let confirmHandler: ConfirmHandler | null = null;
export function setTxConfirmHandler(handler: ConfirmHandler | null): void {
  confirmHandler = handler;
}

/** Build the wallet view the guard needs. */
export async function walletViewOf(lucid: LucidLike): Promise<WalletView> {
  const { paymentCredentialOf } = await import("@lucid-evolution/lucid");
  const [address, utxos] = await Promise.all([lucid.wallet().address(), lucid.wallet().getUtxos()]);
  const addresses = new Set<string>([address, ...utxos.map((u) => u.address)]);
  const keyHashes = new Set<string>();
  for (const a of addresses) {
    try {
      const cred = paymentCredentialOf(a);
      if (cred.type === "Key") keyHashes.add(cred.hash);
    } catch {
      // Not a Shelley address; it simply contributes no key hash.
    }
  }
  const map = new Map<string, Assets>();
  for (const u of utxos) map.set(`${u.txHash}#${u.outputIndex}`, { ...u.assets });
  return { addresses: [...addresses], keyHashes: [...keyHashes], utxos: map };
}

/** Decode and check; throws TxIntentRejected on any violation. */
export async function assertIntent(
  txCbor: string,
  intent: TxIntent,
  wallet: WalletView,
  view: TrustView = trust,
): Promise<DecodedTx> {
  const { CML } = await import("@lucid-evolution/lucid");
  const decoded = decodeTx(CML, txCbor);
  const violations = checkTx(decoded, intent, wallet, view);
  if (violations.length) throw new TxIntentRejected(intent.action, violations);
  if (confirmHandler) {
    const go = await confirmHandler(intent.action, summariseTx(decoded, wallet, view));
    if (!go) throw new Error("Cancelled before signing.");
  }
  return decoded;
}

/** Check, then sign with the connected wallet. */
export async function signGuarded<Signed>(
  lucid: LucidLike,
  completed: SignBuilderLike<Signed>,
  intent: TxIntent,
): Promise<Signed> {
  await assertIntent(completed.toCBOR(), intent, await walletViewOf(lucid));
  return completed.sign.withWallet().complete();
}

/** Check, then add this wallet's witness to a multi-signature draft. */
export async function partialSignGuarded(
  lucid: LucidLike,
  completed: Pick<SignBuilderLike<unknown>, "toCBOR" | "partialSign">,
  intent: TxIntent,
): Promise<string> {
  await assertIntent(completed.toCBOR(), intent, await walletViewOf(lucid));
  return completed.partialSign.withWallet();
}
