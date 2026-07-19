/**
 * Read the connected wallet's live on-chain vault position from the Preprod
 * script address. All work happens in the browser via Lucid + Blockfrost.
 */

import {
  checkVaultPreconditions,
  decodeVaultError,
  getVaultScript,
  initLucidWithWallet,
} from "./vault";

export interface VaultHolding {
  txHash: string;
  outputIndex: number;
  lovelace: bigint;
  ada: number;
  ownerPkh: string;
}

export interface VaultHoldings {
  address: string;
  ownerPkh: string;
  holdings: VaultHolding[];
  totalAda: number;
}

export async function fetchMyVaultHoldings(): Promise<VaultHoldings> {
  const pre = checkVaultPreconditions();
  if (!pre.ok) throw new Error(pre.reason);

  try {
    const { lucid, lucidMod } = await initLucidWithWallet();
    const { Data, paymentCredentialOf } = lucidMod;

    const address = await lucid.wallet().address();
    const cred = paymentCredentialOf(address);
    if (cred.type !== "Key") throw new Error("Wallet isn't a key-hash address.");
    const ownerPkh = cred.hash;

    const script = await getVaultScript(lucid, lucidMod);
    const utxos = await lucid.utxosAt(script.address);
    const VaultDatumSchema = Data.Object({ owner: Data.Bytes() });
    type VaultDatum = { owner: string };

    const holdings: VaultHolding[] = [];
    for (const u of utxos) {
      if (!u.datum) continue;
      try {
        const d = Data.from<VaultDatum>(u.datum, VaultDatumSchema as unknown as VaultDatum);
        if (d.owner !== ownerPkh) continue;
        const lovelace = u.assets.lovelace ?? 0n;
        holdings.push({
          txHash: u.txHash,
          outputIndex: u.outputIndex,
          lovelace,
          ada: Number(lovelace) / 1_000_000,
          ownerPkh,
        });
      } catch {
        // Non-vault datum shape — skip.
      }
    }

    const totalAda = holdings.reduce((n, h) => n + h.ada, 0);
    return { address, ownerPkh, holdings, totalAda };
  } catch (e) {
    throw new Error(decodeVaultError(e));
  }
}
