/**
 * Browser-side publication of reference scripts.
 *
 * Derives the applied script for one validator of one asset, pays it into a
 * single output at the dedicated reference-script address, and returns the
 * submitted transaction hash. The caller then asks the server to verify and
 * record it — the registry is never written from what the browser claims.
 */

import { checkVaultPreconditions, getVaultScript, initLucidWithWallet } from "./vault";
import { getReceiptPolicy, getYieldVaultScript } from "./yield-vault";
import { buildPublishReferenceScriptTx } from "./ref-scripts";
import type { ValidatorKey } from "./ref-scripts.shared";

/** Applied CBOR for one validator of one asset, derived in the browser. */
export async function deriveAppliedCbor(
  validatorKey: ValidatorKey,
  assetId: string,
): Promise<string> {
  const { lucid, lucidMod } = await initLucidWithWallet();
  if (validatorKey === "vault") return (await getVaultScript(lucid, lucidMod, assetId)).cbor;
  if (validatorKey === "yield_vault") return getYieldVaultScript(lucidMod, assetId).cbor;
  return getReceiptPolicy(lucidMod, assetId).cbor;
}

export interface PublishResult {
  txHash: string;
  lovelace: bigint;
  address: string;
}

/**
 * Build, sign, and submit the publication transaction. The reference output is
 * always index 0 so the server can verify it deterministically.
 */
export async function publishReferenceScript(
  validatorKey: ValidatorKey,
  assetId: string,
): Promise<PublishResult> {
  const pre = checkVaultPreconditions();
  if (!pre.ok) throw new Error(pre.reason);

  const { lucid, lucidMod } = await initLucidWithWallet();
  const appliedCbor =
    validatorKey === "vault"
      ? (await getVaultScript(lucid, lucidMod, assetId)).cbor
      : validatorKey === "yield_vault"
        ? getYieldVaultScript(lucidMod, assetId).cbor
        : getReceiptPolicy(lucidMod, assetId).cbor;

  const built = await buildPublishReferenceScriptTx(
    lucid as unknown as Parameters<typeof buildPublishReferenceScriptTx>[0],
    appliedCbor,
  );
  const tx = built.tx as { sign: { withWallet: () => { complete: () => Promise<{ submit: () => Promise<string> }> } } };
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  return { txHash, lovelace: built.lovelace, address: built.address };
}
