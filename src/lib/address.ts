/**
 * Cardano bech32 address parsing for the "view by address" read-only mode.
 * Handles payment (`addr` / `addr_test`) and stake (`stake` / `stake_test`)
 * addresses; rejects anything with a bad checksum or unknown HRP.
 */
import { bech32 } from "bech32";

export type CardanoAddressKind = "payment" | "stake";

export interface ParsedCardanoAddress {
  bech32: string;
  kind: CardanoAddressKind;
  networkId: 0 | 1;
}

export type ParseResult =
  | { ok: true; value: ParsedCardanoAddress }
  | { ok: false; error: string };

export function parseCardanoAddress(input: string): ParseResult {
  const addr = (input ?? "").trim().toLowerCase();
  if (!addr) return { ok: false, error: "Enter a Cardano address." };
  if (!/^(addr|stake)(_test)?1[0-9a-z]+$/.test(addr)) {
    return { ok: false, error: "Address must start with addr, addr_test, stake, or stake_test." };
  }
  let decoded: { prefix: string; words: number[] };
  try {
    decoded = bech32.decode(addr, 200);
  } catch {
    return { ok: false, error: "Invalid bech32 (bad checksum or characters)." };
  }
  let kind: CardanoAddressKind;
  let networkId: 0 | 1;
  switch (decoded.prefix) {
    case "addr":       kind = "payment"; networkId = 1; break;
    case "addr_test":  kind = "payment"; networkId = 0; break;
    case "stake":      kind = "stake";   networkId = 1; break;
    case "stake_test": kind = "stake";   networkId = 0; break;
    default:
      return { ok: false, error: `Unrecognised address prefix "${decoded.prefix}".` };
  }
  return { ok: true, value: { bech32: addr, kind, networkId } };
}

export function shortenAddress(addr: string | null | undefined): string {
  if (!addr) return "";
  if (addr.length <= 16) return addr;
  return `${addr.slice(0, 10)}…${addr.slice(-6)}`;
}

/**
 * Payment credential hash (28-byte hex) of a bech32 payment address.
 *
 * Shelley payment addresses are `1 header byte + 28-byte payment credential
 * (+ 28-byte staking part)`. Vault Position datums store exactly that hash as
 * `owner`, so this is how the UI matches on-chain positions to a wallet
 * without loading Lucid.
 */
export function paymentKeyHashOf(addr: string | null | undefined): string | null {
  if (!addr) return null;
  const parsed = parseCardanoAddress(addr);
  if (!parsed.ok || parsed.value.kind !== "payment") return null;
  try {
    const { words } = bech32.decode(parsed.value.bech32, 200);
    const bytes = bech32.fromWords(words);
    if (bytes.length < 29) return null;
    return Array.from(bytes.slice(1, 29))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return null;
  }
}
