/**
 * Shared reference-script constants.
 *
 * Kept in its own module so both the browser helpers (`ref-scripts.ts`) and
 * the server-only verifier (`ref-scripts-verify.server.ts`) agree on the one
 * address that may ever hold a published reference script, without the server
 * pulling in the browser Supabase client.
 */

/** Dedicated address that holds every published reference-script UTxO. */
export const REF_SCRIPT_HOME_ADDRESS = "<PASTE THE ADDRESS FROM STEP 0 HERE>";

export type ValidatorKey = "vault" | "yield_vault" | "receipt";

export const VALIDATOR_KEYS: ValidatorKey[] = ["vault", "yield_vault", "receipt"];

export function isValidatorKey(v: unknown): v is ValidatorKey {
  return typeof v === "string" && (VALIDATOR_KEYS as string[]).includes(v);
}

/** True while Step 0 has not been completed and the address is a placeholder. */
export function isPlaceholderHome(): boolean {
  return REF_SCRIPT_HOME_ADDRESS.startsWith("<");
}

/** Human labels for the wizard rows. */
export const VALIDATOR_LABELS: Record<ValidatorKey, string> = {
  vault: "vault (Stage 3)",
  yield_vault: "yield_vault",
  receipt: "receipt policy",
};
