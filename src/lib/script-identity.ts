/**
 * Script build identity.
 *
 * Any change to a validator — a Step 2 style receipt-policy binding, a version
 * bump, a rebuild that moves the CBOR — changes the applied script hash and
 * therefore every derived vault address. Anything the UI cached against an old
 * address (chain state, history, holdings, registry rows) is then wrong.
 *
 * `SCRIPT_BUILD_ID` fingerprints the pinned blueprints plus their instance
 * versions. It is stamped into derivation cache keys and compared against the
 * last value the browser saw, so a new build automatically discards caches
 * instead of rendering a stale address.
 */

import { VAULT_BLUEPRINT_HASH, VAULT_VERSION } from "./vault";
import { RECEIPT_BLUEPRINT_HASH, YIELD_BLUEPRINT_HASH, YIELD_VAULT_VERSION } from "./yield-vault";
import { SUSDR_BLUEPRINT_HASH, SUSDR_VAULT_VERSION } from "./susdr-vault";
import { APP_NETWORK } from "./network";

/** Stable, human-readable fingerprint of the scripts this build can derive. */
export const SCRIPT_BUILD_ID = [
  APP_NETWORK,
  `v${String(VAULT_VERSION)}`,
  VAULT_BLUEPRINT_HASH.slice(0, 12),
  `y${String(YIELD_VAULT_VERSION)}`,
  YIELD_BLUEPRINT_HASH.slice(0, 12),
  `r${RECEIPT_BLUEPRINT_HASH.slice(0, 12)}`,
  `s${String(SUSDR_VAULT_VERSION)}${SUSDR_BLUEPRINT_HASH.slice(0, 12)}`,
].join("-");

const STORAGE_KEY = "stellaris.script-build-id";

/** The build id this browser last rendered addresses for, if any. */
export function readStoredScriptBuildId(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Record the current build id so the next load can detect a change. */
export function writeStoredScriptBuildId(): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, SCRIPT_BUILD_ID);
  } catch {
    /* private mode — the in-memory cache is still busted for this session */
  }
}

/** Query key prefix for anything derived from the current scripts. */
export function scriptScopedKey(...parts: Array<string | number | null | undefined>) {
  return ["script", SCRIPT_BUILD_ID, ...parts];
}
