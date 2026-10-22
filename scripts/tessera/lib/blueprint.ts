/**
 * Tessera scripts from contracts/tessera/plutus.json, checked against the pins
 * in src/lib/tessera-blueprint.ts before any parameter is applied.
 *
 * Refuses if the blueprint's compiled code does not hash to its pin — the same
 * drift the CI guard catches, enforced again at the moment of deployment.
 */
import { readFileSync } from "node:fs";
import {
  Constr,
  applyParamsToScript,
  validatorToAddress,
  validatorToRewardAddress,
  validatorToScriptHash,
  type Network,
} from "@lucid-evolution/lucid";
import {
  TESSERA_ELIGIBILITY_BLUEPRINT_HASH,
  TESSERA_FIRST_LOSS_BLUEPRINT_HASH,
  TESSERA_QUEUE_ADMIN_BLUEPRINT_HASH,
  TESSERA_QUEUE_FLOW_BLUEPRINT_HASH,
  TESSERA_QUEUE_SHORT_BLUEPRINT_HASH,
  TESSERA_REDEEM_QUEUE_BLUEPRINT_HASH,
  TESSERA_RESERVE_BLUEPRINT_HASH,
  TESSERA_STSRA_VAULT_BLUEPRINT_HASH,
  TESSERA_VAULT_OPS_BLUEPRINT_HASH,
} from "../../../src/lib/tessera-blueprint";

export const BLUEPRINT_PATH = "contracts/tessera/plutus.json";

export interface Seed {
  txHash: string;
  outputIndex: number;
}

export interface AppliedScript {
  script: { type: "PlutusV3"; script: string };
  hash: string;
}

interface Blueprint {
  validators: Array<{ title: string; hash: string; compiledCode: string }>;
}

function loadBlueprint(path: string): Blueprint {
  return JSON.parse(readFileSync(path, "utf8")) as Blueprint;
}

/** The unapplied compiled code of `title`, verified against `pinned`. */
export function pinnedCode(title: string, pinned: string, path = BLUEPRINT_PATH): string {
  const v = loadBlueprint(path).validators.find((x) => x.title === title);
  if (!v) throw new Error(`${path} has no ${title}`);
  const actual = validatorToScriptHash({ type: "PlutusV3", script: v.compiledCode });
  if (v.hash !== pinned || actual !== pinned) {
    throw new Error(
      `${title}: blueprint hash ${v.hash}, compiled code hashes to ${actual}, pin is ${pinned}. ` +
        "Run `aiken build` and the drift guard; refusing to deploy a script that is not the pinned one.",
    );
  }
  return v.compiledCode;
}

/** Plutus data for an Aiken OutputReference. */
export function seedData(seed: Seed): Constr<unknown> {
  return new Constr(0, [seed.txHash, BigInt(seed.outputIndex)]);
}

/** `reserve.reserve` applied to its seed: TSRA policy, thread-token policy, Reserve address. */
export function applyReserve(seed: Seed, path = BLUEPRINT_PATH): AppliedScript {
  const code = pinnedCode("reserve.reserve.mint", TESSERA_RESERVE_BLUEPRINT_HASH, path);
  const script = {
    type: "PlutusV3" as const,
    script: applyParamsToScript(code, [seedData(seed)] as never),
  };
  return { script, hash: validatorToScriptHash(script) };
}

/** `eligibility.eligibility` applied to the reserve hash: the eligibility-token policy. */
export function applyEligibility(reserveHash: string, path = BLUEPRINT_PATH): AppliedScript {
  const code = pinnedCode("eligibility.eligibility.mint", TESSERA_ELIGIBILITY_BLUEPRINT_HASH, path);
  const script = {
    type: "PlutusV3" as const,
    script: applyParamsToScript(code, [reserveHash] as never),
  };
  return { script, hash: validatorToScriptHash(script) };
}

function apply(title: string, pinned: string, params: unknown[], path: string): AppliedScript {
  const script = {
    type: "PlutusV3" as const,
    script: applyParamsToScript(pinnedCode(title, pinned, path), params as never),
  };
  return { script, hash: validatorToScriptHash(script) };
}

/** `first_loss.first_loss` applied to `(seed, reserve)`: the first-loss State and its thread policy. */
export function applyFirstLoss(seed: Seed, reserveHash: string, path = BLUEPRINT_PATH) {
  return apply(
    "first_loss.first_loss.mint",
    TESSERA_FIRST_LOSS_BLUEPRINT_HASH,
    [seedData(seed), reserveHash],
    path,
  );
}

/** `vault_ops.vault_ops` applied to the reserve: the vault's withdraw-zero ops script. */
export function applyVaultOps(reserveHash: string, path = BLUEPRINT_PATH) {
  return apply(
    "vault_ops.vault_ops.withdraw",
    TESSERA_VAULT_OPS_BLUEPRINT_HASH,
    [reserveHash],
    path,
  );
}

/** `stsra_vault.stsra_vault` applied to `(seed, reserve, ops)`: the vault and the sTSRA policy. */
export function applyVault(
  seed: Seed,
  reserveHash: string,
  opsHash: string,
  path = BLUEPRINT_PATH,
) {
  return apply(
    "stsra_vault.stsra_vault.mint",
    TESSERA_STSRA_VAULT_BLUEPRINT_HASH,
    [seedData(seed), reserveHash, opsHash],
    path,
  );
}

/** The script's enterprise address — where outputs.genesis_out_ok requires the genesis UTxOs. */
export function enterpriseAddress(network: Network, s: AppliedScript): string {
  return validatorToAddress(network, s.script);
}

/** The script's reward (stake) address — the withdraw-zero gate for `vault_ops`. */
export function rewardAddress(network: Network, s: AppliedScript): string {
  return validatorToRewardAddress(network, s.script);
}

/** The three queue withdraw-zero scripts, each applied to the reserve (Phase 2.6). */
export function applyQueueScripts(reserveHash: string, path = BLUEPRINT_PATH) {
  return {
    flow: apply(
      "queue_flow.queue_flow.withdraw",
      TESSERA_QUEUE_FLOW_BLUEPRINT_HASH,
      [reserveHash],
      path,
    ),
    admin: apply(
      "queue_admin.queue_admin.withdraw",
      TESSERA_QUEUE_ADMIN_BLUEPRINT_HASH,
      [reserveHash],
      path,
    ),
    short: apply(
      "queue_short.queue_short.withdraw",
      TESSERA_QUEUE_SHORT_BLUEPRINT_HASH,
      [reserveHash],
      path,
    ),
  };
}

/** `redeem_queue` applied to `(seed, reserve, flow, admin, short)`: the queue address and policy. */
export function applyRedeemQueue(
  seed: Seed,
  reserveHash: string,
  q: { flow: string; admin: string; short: string },
  path = BLUEPRINT_PATH,
) {
  return apply(
    "redeem_queue.redeem_queue.mint",
    TESSERA_REDEEM_QUEUE_BLUEPRINT_HASH,
    [seedData(seed), reserveHash, q.flow, q.admin, q.short],
    path,
  );
}
