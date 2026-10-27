import { bech32 } from "bech32";
import { decodePlutusDatum, type PlutusData } from "./plutus-cbor";

/** Preserve the snapshot reader's Data.from shape without loading Lucid/WASM. */
function datumValue(data: PlutusData): unknown {
  switch (data.kind) {
    case "int":
    case "bytes":
      return data.value;
    case "list":
      return data.items.map(datumValue);
    case "map":
      return new Map(data.entries.map(([key, value]) => [datumValue(key), datumValue(value)]));
    case "constr":
      return { index: data.index, fields: data.fields.map(datumValue) };
  }
}

export function decodeTesseraDatum(hex: string): unknown {
  return datumValue(decodePlutusDatum(hex));
}

function constr(value: unknown): { index: number; fields: unknown[] } {
  if (
    !value || typeof value !== "object" || !("index" in value) ||
    !("fields" in value) || typeof value.index !== "number" || !Array.isArray(value.fields)
  ) throw new Error("Expected address constructor");
  return { index: value.index, fields: value.fields };
}

function credential(value: unknown) {
  const c = constr(value);
  const hash = c.fields[0];
  if ((c.index !== 0 && c.index !== 1) || typeof hash !== "string" || !/^[a-f0-9]{56}$/i.test(hash)) {
    throw new Error("Invalid address credential");
  }
  return { script: c.index === 1, bytes: Array.from({ length: 28 }, (_, i) =>
    Number.parseInt(hash.slice(i * 2, i * 2 + 2), 16)) };
}

/** Shelley Preprod address encoding, including key/script inline stake credentials. */
export function tesseraAddressToBech32(value: unknown): string {
  const a = constr(value);
  if (a.index !== 0) throw new Error("Invalid address constructor");
  const payment = credential(a.fields[0]);
  const stakeOption = constr(a.fields[1]);
  let bytes: number[];
  if (stakeOption.index === 1) {
    bytes = [payment.script ? 0x70 : 0x60, ...payment.bytes];
  } else if (stakeOption.index === 0) {
    const inline = constr(stakeOption.fields[0]);
    if (inline.index !== 0) throw new Error("pointer stake credentials are not supported");
    const stake = credential(inline.fields[0]);
    const type = (payment.script ? 1 : 0) + (stake.script ? 2 : 0);
    bytes = [type << 4, ...payment.bytes, ...stake.bytes];
  } else {
    throw new Error("Invalid stake credential option");
  }
  return bech32.encode("addr_test", bech32.toWords(bytes), 200);
}