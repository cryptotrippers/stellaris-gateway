/**
 * Server-side verification of a CIP-30 `signData` result (CIP-8 COSE_Sign1 +
 * COSE_Key), without WebAssembly: a tiny CBOR reader, the COSE Sig_structure,
 * WebCrypto Ed25519 and blake2b-224 from @noble/hashes. Runs on Node and on
 * the Cloudflare Worker runtime alike.
 *
 * Plain shared module (no server imports) so it can be unit-tested.
 */

import { blake2b } from "@noble/hashes/blake2.js";

type Cbor = number | bigint | Uint8Array | string | boolean | null | undefined | Cbor[] | Map<Cbor, Cbor>;

export function hexToBytes(hex: string): Uint8Array {
  const h = (hex ?? "").trim().toLowerCase();
  if (!/^([0-9a-f]{2})*$/.test(h)) throw new Error("Expected hex.");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** Minimal definite-length CBOR decoder (enough for COSE_Sign1 / COSE_Key). */
export function decodeCbor(bytes: Uint8Array): Cbor {
  let pos = 0;
  const need = (n: number) => {
    if (pos + n > bytes.length) throw new Error("Truncated CBOR.");
  };
  const readLen = (info: number): number => {
    if (info < 24) return info;
    const size = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : 0;
    if (!size) throw new Error("Indefinite-length CBOR is not accepted.");
    need(size);
    let v = 0;
    for (let i = 0; i < size; i++) v = v * 256 + bytes[pos++]!;
    if (!Number.isSafeInteger(v)) throw new Error("CBOR length too large.");
    return v;
  };
  const item = (depth: number): Cbor => {
    if (depth > 16) throw new Error("CBOR nested too deeply.");
    need(1);
    const ib = bytes[pos++]!;
    const major = ib >> 5;
    const info = ib & 0x1f;
    switch (major) {
      case 0:
        return readLen(info);
      case 1:
        return -1 - readLen(info);
      case 2: {
        const n = readLen(info);
        need(n);
        const b = bytes.slice(pos, pos + n);
        pos += n;
        return b;
      }
      case 3: {
        const n = readLen(info);
        need(n);
        const s = new TextDecoder("utf-8", { fatal: true }).decode(bytes.slice(pos, pos + n));
        pos += n;
        return s;
      }
      case 4: {
        const n = readLen(info);
        const arr: Cbor[] = [];
        for (let i = 0; i < n; i++) arr.push(item(depth + 1));
        return arr;
      }
      case 5: {
        const n = readLen(info);
        const m = new Map<Cbor, Cbor>();
        for (let i = 0; i < n; i++) {
          const k = item(depth + 1);
          m.set(k, item(depth + 1));
        }
        return m;
      }
      case 6:
        readLen(info);
        return item(depth + 1);
      case 7:
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
        if (info === 23) return undefined;
        throw new Error("Unsupported CBOR simple value.");
      default:
        throw new Error("Bad CBOR.");
    }
  };
  const v = item(0);
  if (pos !== bytes.length) throw new Error("Trailing bytes after CBOR item.");
  return v;
}

function head(major: number, len: number): number[] {
  if (len < 24) return [(major << 5) | len];
  if (len < 0x100) return [(major << 5) | 24, len];
  if (len < 0x10000) return [(major << 5) | 25, len >> 8, len & 0xff];
  return [(major << 5) | 26, (len >>> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff];
}

function bstr(b: Uint8Array): number[] {
  return [...head(2, b.length), ...b];
}

/** COSE Sig_structure for COSE_Sign1 with empty external AAD. */
export function sigStructure(protectedBytes: Uint8Array, payload: Uint8Array): Uint8Array {
  const ctx = new TextEncoder().encode("Signature1");
  return new Uint8Array([
    ...head(4, 4),
    ...head(3, ctx.length),
    ...ctx,
    ...bstr(protectedBytes),
    ...bstr(new Uint8Array(0)),
    ...bstr(payload),
  ]);
}

export interface AddressInfo {
  /** Payment key hash (28 bytes hex). */
  paymentKeyHash: string;
  networkId: number;
  /** True when the payment part is a script, not a key. */
  scriptPayment: boolean;
}

/** Read the header and payment credential of a raw Shelley address. */
export function inspectAddressBytes(addr: Uint8Array): AddressInfo {
  if (addr.length < 29) throw new Error("Not a Shelley payment address.");
  const header = addr[0]!;
  const type = header >> 4;
  if (type > 7) throw new Error("Only payment addresses can be linked.");
  return {
    paymentKeyHash: bytesToHex(addr.slice(1, 29)),
    networkId: header & 0x0f,
    // Types 1, 3, 5 and 7 carry a script hash as the payment credential.
    scriptPayment: (type & 1) === 1,
  };
}

export interface VerifiedSignature {
  addressHex: string;
  payload: Uint8Array;
  publicKeyHash: string;
}

/**
 * Verify a CIP-30 DataSignature. Returns what was actually signed; the caller
 * must still compare the payload and the address against what it expects.
 */
export async function verifyCip30Signature(
  signatureHex: string,
  keyHex: string,
): Promise<VerifiedSignature> {
  const sign1 = decodeCbor(hexToBytes(signatureHex));
  if (!Array.isArray(sign1) || sign1.length !== 4) throw new Error("Malformed signature.");
  const [prot, unprot, payload, signature] = sign1;
  if (!(prot instanceof Uint8Array) || !(signature instanceof Uint8Array)) {
    throw new Error("Malformed signature.");
  }
  if (!(payload instanceof Uint8Array)) throw new Error("Detached payloads are not accepted.");
  if (unprot instanceof Map && unprot.get("hashed") === true) {
    throw new Error("Hashed payloads are not accepted.");
  }
  const headers = decodeCbor(prot);
  if (!(headers instanceof Map)) throw new Error("Malformed signature headers.");
  if (headers.get(1) !== -8) throw new Error("Only EdDSA signatures are accepted.");
  const address = headers.get("address");
  if (!(address instanceof Uint8Array)) throw new Error("The signature does not name an address.");

  const coseKey = decodeCbor(hexToBytes(keyHex));
  if (!(coseKey instanceof Map)) throw new Error("Malformed key.");
  const x = coseKey.get(-2);
  if (!(x instanceof Uint8Array) || x.length !== 32) throw new Error("Malformed public key.");
  if (signature.length !== 64) throw new Error("Malformed signature bytes.");

  const key = await crypto.subtle.importKey("raw", x, { name: "Ed25519" }, false, ["verify"]);
  const ok = await crypto.subtle.verify(
    { name: "Ed25519" },
    key,
    signature,
    sigStructure(prot, payload),
  );
  if (!ok) throw new Error("The wallet signature is not valid.");

  return {
    addressHex: bytesToHex(address),
    payload,
    publicKeyHash: bytesToHex(blake2b(x, { dkLen: 28 })),
  };
}
