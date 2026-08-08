/**
 * Minimal, dependency-free CBOR reader for Plutus data.
 *
 * Blockfrost returns `inline_datum` as a hex CBOR string. We need to read it
 * on the server (Cloudflare Worker) where Lucid's WASM decoder cannot run, so
 * this implements just the subset of CBOR that Plutus data uses:
 *
 *   major 0/1  unsigned / negative integers (incl. bignum tags 2 and 3)
 *   major 2    byte strings (definite + indefinite)
 *   major 4    arrays (definite + indefinite)
 *   major 5    maps
 *   major 6    tags — constructor tags 121..127 and 1280..1400
 *   major 7    simple values (break, null, bool)
 *
 * Anything else throws. This is a reader only; it never builds CBOR.
 */

export type PlutusData =
  | { kind: "int"; value: bigint }
  | { kind: "bytes"; value: string } // hex
  | { kind: "list"; items: PlutusData[] }
  | { kind: "map"; entries: Array<[PlutusData, PlutusData]> }
  | { kind: "constr"; index: number; fields: PlutusData[] };

const BREAK = Symbol("cbor-break");

class Reader {
  private readonly buf: Uint8Array;
  private pos = 0;

  constructor(hex: string) {
    const clean = hex.trim();
    if (clean.length % 2 !== 0) throw new Error("Invalid CBOR hex length");
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out.length; i++) {
      const byte = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
      if (Number.isNaN(byte)) throw new Error("Invalid CBOR hex");
      out[i] = byte;
    }
    this.buf = out;
  }

  private byte(): number {
    if (this.pos >= this.buf.length) throw new Error("Unexpected end of CBOR");
    return this.buf[this.pos++]!;
  }

  private bytes(n: number): Uint8Array {
    if (this.pos + n > this.buf.length) throw new Error("Unexpected end of CBOR");
    const slice = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return slice;
  }

  private argument(info: number): bigint | "indefinite" {
    if (info < 24) return BigInt(info);
    if (info === 24) return BigInt(this.byte());
    if (info === 25) {
      const b = this.bytes(2);
      return (BigInt(b[0]!) << 8n) | BigInt(b[1]!);
    }
    if (info === 26) {
      const b = this.bytes(4);
      let v = 0n;
      for (const x of b) v = (v << 8n) | BigInt(x);
      return v;
    }
    if (info === 27) {
      const b = this.bytes(8);
      let v = 0n;
      for (const x of b) v = (v << 8n) | BigInt(x);
      return v;
    }
    if (info === 31) return "indefinite";
    throw new Error(`Unsupported CBOR additional info ${info}`);
  }

  read(): PlutusData | typeof BREAK {
    const initial = this.byte();
    const major = initial >> 5;
    const info = initial & 0x1f;

    if (major === 0) {
      const a = this.argument(info);
      if (a === "indefinite") throw new Error("Indefinite integer");
      return { kind: "int", value: a };
    }

    if (major === 1) {
      const a = this.argument(info);
      if (a === "indefinite") throw new Error("Indefinite integer");
      return { kind: "int", value: -1n - a };
    }

    if (major === 2) {
      const a = this.argument(info);
      if (a === "indefinite") {
        let hex = "";
        for (;;) {
          const chunk = this.read();
          if (chunk === BREAK) break;
          if (chunk.kind !== "bytes") throw new Error("Bad indefinite bytes chunk");
          hex += chunk.value;
        }
        return { kind: "bytes", value: hex };
      }
      return { kind: "bytes", value: toHex(this.bytes(Number(a))) };
    }

    if (major === 4) {
      const a = this.argument(info);
      const items: PlutusData[] = [];
      if (a === "indefinite") {
        for (;;) {
          const item = this.read();
          if (item === BREAK) break;
          items.push(item);
        }
      } else {
        for (let i = 0n; i < a; i++) {
          const item = this.read();
          if (item === BREAK) throw new Error("Unexpected break in array");
          items.push(item);
        }
      }
      return { kind: "list", items };
    }

    if (major === 5) {
      const a = this.argument(info);
      const entries: Array<[PlutusData, PlutusData]> = [];
      const readPair = () => {
        const k = this.read();
        if (k === BREAK) return false;
        const v = this.read();
        if (v === BREAK) throw new Error("Unexpected break in map");
        entries.push([k, v]);
        return true;
      };
      if (a === "indefinite") {
        while (readPair()) { /* until break */ }
      } else {
        for (let i = 0n; i < a; i++) readPair();
      }
      return { kind: "map", entries };
    }

    if (major === 6) {
      const a = this.argument(info);
      if (a === "indefinite") throw new Error("Indefinite tag");
      const tag = Number(a);
      const inner = this.read();
      if (inner === BREAK) throw new Error("Unexpected break after tag");

      // Bignums
      if (tag === 2 || tag === 3) {
        if (inner.kind !== "bytes") throw new Error("Bad bignum payload");
        let v = 0n;
        for (let i = 0; i < inner.value.length; i += 2) {
          v = (v << 8n) | BigInt(Number.parseInt(inner.value.slice(i, i + 2), 16));
        }
        return { kind: "int", value: tag === 2 ? v : -1n - v };
      }

      // Constructor tags
      let index: number | null = null;
      if (tag >= 121 && tag <= 127) index = tag - 121;
      else if (tag >= 1280 && tag <= 1400) index = tag - 1280 + 7;
      else if (tag === 102) {
        // General form: 102([index, fields])
        if (inner.kind !== "list" || inner.items.length !== 2) throw new Error("Bad constr(102)");
        const idx = inner.items[0]!;
        const fields = inner.items[1]!;
        if (idx.kind !== "int" || fields.kind !== "list") throw new Error("Bad constr(102)");
        return { kind: "constr", index: Number(idx.value), fields: fields.items };
      }

      if (index === null) throw new Error(`Unsupported CBOR tag ${tag}`);
      if (inner.kind !== "list") throw new Error("Constructor payload is not a list");
      return { kind: "constr", index, fields: inner.items };
    }

    if (major === 7) {
      if (info === 31) return BREAK;
      if (info === 20) return { kind: "constr", index: 0, fields: [] }; // false
      if (info === 21) return { kind: "constr", index: 1, fields: [] }; // true
      if (info === 22) return { kind: "list", items: [] }; // null
      throw new Error(`Unsupported CBOR simple value ${info}`);
    }

    throw new Error(`Unsupported CBOR major type ${major}`);
  }
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/** Decode a hex-encoded Plutus datum. Throws on malformed input. */
export function decodePlutusDatum(hex: string): PlutusData {
  const reader = new Reader(hex);
  const value = reader.read();
  if (value === BREAK) throw new Error("Unexpected CBOR break at top level");
  return value;
}

// ---------------------------------------------------------------------------
// Field accessors
// ---------------------------------------------------------------------------

export function asInt(d: PlutusData | undefined): bigint {
  if (!d || d.kind !== "int") throw new Error("Expected integer field");
  return d.value;
}

export function asBytes(d: PlutusData | undefined): string {
  if (!d || d.kind !== "bytes") throw new Error("Expected bytes field");
  return d.value;
}

export function asList(d: PlutusData | undefined): PlutusData[] {
  if (!d || d.kind !== "list") throw new Error("Expected list field");
  return d.items;
}

export function asBool(d: PlutusData | undefined): boolean {
  if (!d || d.kind !== "constr" || d.fields.length !== 0) throw new Error("Expected bool field");
  return d.index === 1;
}
