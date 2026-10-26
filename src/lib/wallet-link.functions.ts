/**
 * Proving that a Cardano wallet belongs to a signed-in account.
 *
 * 1. requestWalletNonce: the server checks the address (Preprod, key-based),
 *    stores a random nonce with the account, address and expiry, and returns
 *    the exact message to sign.
 * 2. The browser asks the wallet to CIP-30 `signData` that message.
 * 3. confirmWalletLink: the server reloads the nonce, rebuilds the message
 *    from what it stored, verifies the signature, checks the signing key is
 *    the address's payment key, burns the nonce and only then saves the link.
 *
 * A wallet address the browser merely reports never counts for anything.
 * Only imports, types and server-function declarations live here.
 */

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { bech32 } from "bech32";
import {
  bytesToHex,
  hexToBytes,
  inspectAddressBytes,
  verifyCip30Signature,
} from "./cip30-signature";
import {
  WALLET_LINK_NETWORK,
  WALLET_LINK_TTL_MS,
  buildWalletLinkMessage,
  utf8Hex,
} from "./wallet-link.shared";

export interface LinkedWallet {
  address: string;
  payment_key_hash: string;
  verified_at: string;
}

/** The caller's proven wallets. */
export const getMyLinkedWallets = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<LinkedWallet[]> => {
    const { data, error } = await context.supabase
      .from("linked_wallets")
      .select("address, payment_key_hash, verified_at")
      .eq("user_id", context.userId)
      .order("verified_at", { ascending: false });
    if (error) throw new Error(error.message);
    return (data ?? []) as LinkedWallet[];
  });

/** Issue a one-time nonce for the given wallet address (raw CIP-30 hex). */
export const requestWalletNonce = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { addressHex: string }) => {
    const bytes = hexToBytes(data?.addressHex ?? "");
    const info = inspectAddressBytes(bytes);
    if (info.networkId !== 0) throw new Error("Only Preprod (addr_test) addresses can be linked.");
    if (info.scriptPayment) throw new Error("A script address cannot be linked to an account.");
    return { addressHex: bytesToHex(bytes) };
  })
  .handler(
    async ({ data, context }): Promise<{ nonce: string; message: string; messageHex: string; addressHex: string }> => {
      const { enforceRateLimit, RATE_RULES, requestDomain } = await import("./rate-limit.server");
      await enforceRateLimit(RATE_RULES.walletNonce, context.userId);
      const domain = await requestDomain();
      const bytes = hexToBytes(data.addressHex);
      const address = bech32.encode("addr_test", bech32.toWords(bytes), 200);
      const rnd = new Uint8Array(24);
      crypto.getRandomValues(rnd);
      const nonce = bytesToHex(rnd);
      const expiresAt = new Date(Date.now() + WALLET_LINK_TTL_MS).toISOString();

      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { error } = await supabaseAdmin.from("wallet_link_nonces").insert({
        user_id: context.userId,
        address,
        nonce,
        expires_at: expiresAt,
      });
      if (error) throw new Error(error.message);

      const message = buildWalletLinkMessage({ userId: context.userId, address, nonce, expiresAt, domain });
      return { nonce, message, messageHex: utf8Hex(message), addressHex: data.addressHex };
    },
  );

/** Verify the signed nonce and save the link. */
export const confirmWalletLink = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { nonce: string; signature: string; key: string }) => {
    if (!/^[0-9a-f]{48}$/.test(data?.nonce ?? "")) throw new Error("Invalid nonce.");
    if (!data?.signature || data.signature.length > 4000) throw new Error("Invalid signature.");
    if (!data?.key || data.key.length > 400) throw new Error("Invalid key.");
    return { nonce: data.nonce, signature: data.signature, key: data.key };
  })
  .handler(async ({ data, context }): Promise<LinkedWallet> => {
    const { enforceRateLimit, RATE_RULES, requestDomain } = await import("./rate-limit.server");
    await enforceRateLimit(RATE_RULES.walletConfirm, context.userId);
    const domain = await requestDomain();
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: row, error } = await supabaseAdmin
      .from("wallet_link_nonces")
      .select("id, user_id, address, nonce, expires_at, used_at")
      .eq("nonce", data.nonce)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!row || row.user_id !== context.userId) throw new Error("This link request was not found.");
    if (row.used_at) throw new Error("This link request has already been used.");
    if (new Date(row.expires_at).getTime() < Date.now()) {
      throw new Error("This link request has expired. Start again.");
    }

    // The stored address must still be a Preprod key address.
    const decoded = bech32.decode(row.address, 200);
    if (decoded.prefix !== "addr_test") throw new Error("Only Preprod addresses can be linked.");
    const addrBytes = Uint8Array.from(bech32.fromWords(decoded.words));
    const info = inspectAddressBytes(addrBytes);
    if (info.networkId !== 0) throw new Error("Only Preprod addresses can be linked.");
    if (info.scriptPayment) throw new Error("A script address cannot be linked to an account.");

    const signed = await verifyCip30Signature(data.signature, data.key);
    if (signed.addressHex !== bytesToHex(addrBytes)) {
      throw new Error("The wallet signed for a different address.");
    }
    if (signed.publicKeyHash !== info.paymentKeyHash) {
      throw new Error("The signing key does not control this address.");
    }
    const expected = buildWalletLinkMessage({
      userId: row.user_id,
      address: row.address,
      nonce: row.nonce,
      expiresAt: new Date(row.expires_at).toISOString(),
      // The confirm must reach the same site the nonce was issued for.
      domain,
    });
    if (new TextDecoder().decode(signed.payload) !== expected) {
      throw new Error("The signed message does not match this link request.");
    }

    // Burn the nonce exactly once.
    const { data: burned, error: burnErr } = await supabaseAdmin
      .from("wallet_link_nonces")
      .update({ used_at: new Date().toISOString() })
      .eq("id", row.id)
      .is("used_at", null)
      .select("id");
    if (burnErr) throw new Error(burnErr.message);
    if (!burned || burned.length === 0) throw new Error("This link request has already been used.");

    const { data: existing } = await supabaseAdmin
      .from("linked_wallets")
      .select("user_id")
      .eq("payment_key_hash", info.paymentKeyHash)
      .maybeSingle();
    if (existing && existing.user_id !== context.userId) {
      throw new Error("This wallet is already linked to another account.");
    }
    const { data: saved, error: saveErr } = await supabaseAdmin
      .from("linked_wallets")
      .upsert(
        {
          user_id: context.userId,
          address: row.address,
          payment_key_hash: info.paymentKeyHash,
          network: WALLET_LINK_NETWORK,
          signature: data.signature,
          verified_at: new Date().toISOString(),
        },
        { onConflict: "payment_key_hash" },
      )
      .select("address, payment_key_hash, verified_at")
      .single();
    if (saveErr) throw new Error(saveErr.message);

    await supabaseAdmin.from("security_audit_log").insert({
      user_id: context.userId,
      action: "wallet_linked",
      detail: { address: row.address } as never,
    });
    return saved as LinkedWallet;
  });
