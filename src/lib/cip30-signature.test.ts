import { describe, expect, test } from "bun:test";
import { blake2b } from "@noble/hashes/blake2.js";
import { bech32 } from "bech32";
import {
  bytesToHex,
  inspectAddressBytes,
  sigStructure,
  verifyCip30Signature,
} from "./cip30-signature";
import { buildWalletLinkMessage } from "./wallet-link.shared";

// --- tiny CBOR encoder for building wallet-shaped fixtures -----------------
const head = (m: number, n: number) =>
  n < 24 ? [(m << 5) | n] : n < 256 ? [(m << 5) | 24, n] : [(m << 5) | 25, n >> 8, n & 255];
const bstr = (b: Uint8Array) => [...head(2, b.length), ...b];
const tstr = (s: string) => {
  const b = new TextEncoder().encode(s);
  return [...head(3, b.length), ...b];
};
const int = (n: number) => (n >= 0 ? head(0, n) : head(1, -1 - n));

async function wallet(header = 0x60) {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const pkh = blake2b(pub, { dkLen: 28 });
  const addr = new Uint8Array([header, ...pkh]);
  return { kp, pub, addr, pkh: bytesToHex(pkh) };
}

async function sign(w: Awaited<ReturnType<typeof wallet>>, message: string, addr = w.addr) {
  const payload = new TextEncoder().encode(message);
  const prot = new Uint8Array([0xa2, ...int(1), ...int(-8), ...tstr("address"), ...bstr(addr)]);
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: "Ed25519" }, w.kp.privateKey, new Uint8Array(sigStructure(prot, payload))),
  );
  const sign1 = new Uint8Array([0x84, ...bstr(prot), 0xa1, ...tstr("hashed"), 0xf4, ...bstr(payload), ...bstr(sig)]);
  const key = new Uint8Array([0xa4, ...int(1), ...int(1), ...int(3), ...int(-8), ...int(-1), ...int(6), ...int(-2), ...bstr(w.pub)]);
  return { signature: bytesToHex(sign1), key: bytesToHex(key) };
}

describe("wallet link signature", () => {
  test("a genuine signature returns the signed address, message and key hash", async () => {
    const w = await wallet();
    const msg = buildWalletLinkMessage({
      userId: "u1",
      address: bech32.encode("addr_test", bech32.toWords(w.addr), 200),
      nonce: "ab".repeat(24),
      expiresAt: "2026-10-24T03:00:00.000Z",
    });
    const s = await sign(w, msg);
    const r = await verifyCip30Signature(s.signature, s.key);
    expect(r.addressHex).toBe(bytesToHex(w.addr));
    expect(new TextDecoder().decode(r.payload)).toBe(msg);
    expect(r.publicKeyHash).toBe(w.pkh);
  });

  test("the message contains app, account, wallet, nonce, preprod and expiry", () => {
    const msg = buildWalletLinkMessage({ userId: "acc-9", address: "addr_test1xyz", nonce: "n0", expiresAt: "T" });
    for (const part of ["Stellaris Gateway", "Account: acc-9", "Wallet: addr_test1xyz", "Nonce: n0", "Network: preprod", "Expires: T"]) {
      expect(msg).toContain(part);
    }
  });

  test("a signature from another key is rejected", async () => {
    const a = await wallet();
    const b = await wallet();
    const s = await sign(a, "hello");
    const forged = { signature: s.signature, key: (await sign(b, "hello")).key };
    await expect(verifyCip30Signature(forged.signature, forged.key)).rejects.toThrow();
  });

  test("a tampered payload is rejected", async () => {
    const w = await wallet();
    const s = await sign(w, "Nonce: aaaa");
    const tampered = s.signature.replace(bytesToHex(new TextEncoder().encode("aaaa")), bytesToHex(new TextEncoder().encode("bbbb")));
    await expect(verifyCip30Signature(tampered, s.key)).rejects.toThrow();
  });

  test("a key signing for an address it does not control is caught by key hash", async () => {
    const a = await wallet();
    const victim = await wallet();
    const s = await sign(a, "m", victim.addr);
    const r = await verifyCip30Signature(s.signature, s.key);
    expect(r.publicKeyHash).not.toBe(inspectAddressBytes(victim.addr).paymentKeyHash);
  });

  test("mainnet and script addresses are identified for rejection", async () => {
    const pkh = new Uint8Array(28).fill(7);
    expect(inspectAddressBytes(new Uint8Array([0x60, ...pkh])).networkId).toBe(0);
    expect(inspectAddressBytes(new Uint8Array([0x61, ...pkh])).networkId).toBe(1);
    expect(inspectAddressBytes(new Uint8Array([0x70, ...pkh])).scriptPayment).toBe(true);
    expect(inspectAddressBytes(new Uint8Array([0x10, ...pkh, ...pkh])).scriptPayment).toBe(true);
    expect(inspectAddressBytes(new Uint8Array([0x00, ...pkh, ...pkh])).scriptPayment).toBe(false);
    expect(() => inspectAddressBytes(new Uint8Array([0xe0, ...pkh]))).toThrow();
  });
});
