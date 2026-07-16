/**
 * Lightweight CIP-30 wallet connector for Cardano.
 * No external deps — reads window.cardano and decodes the balance CBOR manually.
 */

export type CardanoWalletId = "lace" | "eternl" | "nami" | "typhon" | "flint" | "yoroi" | "gerowallet";

export interface CardanoWalletInfo {
  id: CardanoWalletId;
  name: string;
  icon: string;
  installed: boolean;
}

export interface CIP30Api {
  getNetworkId: () => Promise<0 | 1>;
  getUsedAddresses: () => Promise<string[]>;
  getUnusedAddresses: () => Promise<string[]>;
  getChangeAddress: () => Promise<string>;
  getRewardAddresses: () => Promise<string[]>;
  getBalance: () => Promise<string>; // hex CBOR
}

interface WindowCardano {
  [key: string]: {
    name?: string;
    icon?: string;
    apiVersion?: string;
    enable: () => Promise<CIP30Api>;
    isEnabled: () => Promise<boolean>;
  } | undefined;
}

const KNOWN: Array<{ id: CardanoWalletId; name: string }> = [
  { id: "lace", name: "Lace" },
  { id: "eternl", name: "Eternl" },
  { id: "nami", name: "Nami" },
  { id: "typhon", name: "Typhon" },
  { id: "flint", name: "Flint" },
  { id: "yoroi", name: "Yoroi" },
  { id: "gerowallet", name: "GeroWallet" },
];

function win(): WindowCardano | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { cardano?: WindowCardano }).cardano ?? null;
}

export function listWallets(): CardanoWalletInfo[] {
  const c = win();
  return KNOWN.map(w => ({
    id: w.id,
    name: c?.[w.id]?.name ?? w.name,
    icon: c?.[w.id]?.icon ?? "",
    installed: Boolean(c?.[w.id]),
  }));
}

// Minimal CBOR decode for CIP-30 balance: either a uint (lovelace only)
// or an array [coin, multiasset]. We only need the first coin value.
function decodeCborLovelace(hex: string): bigint {
  const bytes = new Uint8Array(hex.match(/.{1,2}/g)?.map(b => parseInt(b, 16)) ?? []);
  let i = 0;
  const readUint = (info: number): bigint => {
    if (info < 24) return BigInt(info);
    if (info === 24) return BigInt(bytes[i++]);
    if (info === 25) { const v = (bytes[i] << 8) | bytes[i+1]; i += 2; return BigInt(v); }
    if (info === 26) {
      const v = (bytes[i] * 2**24) + (bytes[i+1] << 16) + (bytes[i+2] << 8) + bytes[i+3];
      i += 4; return BigInt(v);
    }
    if (info === 27) {
      let v = 0n;
      for (let j = 0; j < 8; j++) v = (v << 8n) | BigInt(bytes[i+j]);
      i += 8; return v;
    }
    return 0n;
  };
  const first = bytes[i++];
  const major = first >> 5;
  const info = first & 0x1f;
  if (major === 0) return readUint(info); // pure uint
  if (major === 4) {
    // array — read first element as uint
    readUint(info); // length
    const head = bytes[i++];
    const m2 = head >> 5;
    const i2 = head & 0x1f;
    if (m2 !== 0) return 0n;
    return readUint(i2);
  }
  return 0n;
}

export async function enableWallet(id: CardanoWalletId) {
  const c = win();
  const w = c?.[id];
  if (!w) throw new Error(`${id} wallet not installed`);
  const api = await w.enable();
  const [networkId, changeAddress, balanceHex, rewardAddrs] = await Promise.all([
    api.getNetworkId(),
    api.getChangeAddress(),
    api.getBalance(),
    api.getRewardAddresses().catch(() => [] as string[]),
  ]);
  const lovelace = decodeCborLovelace(balanceHex);
  return {
    networkId, // 0 = testnet (preprod/preview), 1 = mainnet
    changeAddressHex: changeAddress,
    rewardAddressHex: rewardAddrs[0] ?? null,
    balanceAda: Number(lovelace) / 1_000_000,
  };
}
