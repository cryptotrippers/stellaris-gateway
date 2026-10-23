/**
 * Build (never sign) the four transactions that stand up the sTSRA vault on top
 * of an existing Reserve genesis, in order:
 *
 *   1. firstLoss  — first_loss genesis: consume a seed, mint its `state` token,
 *                   one UTxO at its enterprise address with { balance: 0, epoch: 0 }.
 *   2. opsStake   — register vault_ops' stake credential (Conway reg cert; the
 *                   script's `publish` handler accepts registration only). Every
 *                   later ReportYield / SetBounds / Claim / ReportLoss is a
 *                   withdraw-zero against it, so it must exist first.
 *   3. vault      — stsra_vault genesis: consume a seed, mint its `state` token,
 *                   one State at its enterprise address with empty books, the
 *                   loss index at 1e12, bounds inside their hard limits, the
 *                   first-loss hash and a treasury address.
 *   4. setVault   — reserve `SetVault`: the committee (M-of-N, read from the
 *                   Config) repoints Config.vault_policy at the new vault so its
 *                   Tickets may use VaultClaimBurn; epoch + 1, nothing else moves.
 *
 * Each builder `.chain()`s so the next one spends the previous one's change
 * before anything is submitted; `.chain()` evaluates every script locally,
 * so a successful build means the validators accept these exact transactions.
 */
import { Data, type LucidEvolution, type TxSignBuilder, type UTxO } from "@lucid-evolution/lucid";
import {
  applyFirstLoss,
  applyVault,
  applyVaultOps,
  enterpriseAddress,
  rewardAddress,
  type AppliedScript,
  type Seed,
} from "./blueprint";
import {
  STSRA_NAME,
  THREAD_NAME,
  firstLossGenesisDatumCbor,
  setVaultConfigDatum,
  setVaultRedeemer,
  vaultGenesisProblems,
  vaultStateDatumCbor,
  type VaultBounds,
} from "./vault-genesis";
import { seedProblems } from "./build-genesis";

/** Lovelace each new State UTxO carries. */
export const STATE_LOVELACE = 5_000_000n;

export type StageName = "firstLoss" | "opsStake" | "vault" | "setVault";
export const STAGES: StageName[] = ["firstLoss", "opsStake", "vault", "setVault"];

export interface Built {
  name: string;
  tx: TxSignBuilder;
  record: Record<string, unknown>;
}

export interface VaultContext {
  reserve: AppliedScript;
  reserveAddress: string;
  /** Already-deployed first-loss hash (when resuming after stage 1). */
  firstLossHash?: string;
  /** Already-deployed vault hash (when resuming after stage 3). */
  vaultHash?: string;
  treasuryAddress: string;
  bounds: VaultBounds;
  /** The genuine Reserve Config UTxO (needed for setVault). */
  configUtxo?: UTxO;
  /** Committee key hashes that will sign setVault (at least the threshold). */
  signers?: string[];
}

/** The largest plain-ADA wallet UTxO: a valid one-shot seed. */
export async function pickSeed(lucid: LucidEvolution): Promise<UTxO> {
  const utxos = await lucid.wallet().getUtxos();
  const plain = utxos
    .filter((u) => seedProblems(u).length === 0 && Object.keys(u.assets).length === 1)
    .sort((a, b) => ((b.assets.lovelace ?? 0n) > (a.assets.lovelace ?? 0n) ? 1 : -1));
  if (!plain.length) throw new Error("The operator wallet has no plain ADA UTxO to use as a seed.");
  return plain[0]!;
}

const seedOf = (u: UTxO): Seed => ({ txHash: u.txHash, outputIndex: u.outputIndex });

async function chained(lucid: LucidEvolution, b: ReturnType<LucidEvolution["newTx"]>) {
  const [walletUtxos, , tx] = await b.chain();
  lucid.overrideUTxOs(walletUtxos);
  return tx;
}

export async function buildFirstLoss(lucid: LucidEvolution, ctx: VaultContext): Promise<Built> {
  const network = lucid.config().network!;
  const seed = await pickSeed(lucid);
  const fl = applyFirstLoss(seedOf(seed), ctx.reserve.hash);
  const address = enterpriseAddress(network, fl);
  const tx = await chained(
    lucid,
    lucid
      .newTx()
      .collectFrom([seed])
      .mintAssets({ [fl.hash + THREAD_NAME]: 1n }, Data.void())
      .attach.MintingPolicy(fl.script)
      .pay.ToContract(
        address,
        { kind: "inline", value: firstLossGenesisDatumCbor() },
        { lovelace: STATE_LOVELACE, [fl.hash + THREAD_NAME]: 1n },
      ),
  );
  ctx.firstLossHash = fl.hash;
  return {
    name: "firstLoss",
    tx,
    record: {
      seed: seedOf(seed),
      scriptHash: fl.hash,
      address,
      stateUnit: fl.hash + THREAD_NAME,
      genesisTx: tx.toHash(),
    },
  };
}

export async function buildOpsStake(lucid: LucidEvolution, ctx: VaultContext): Promise<Built> {
  const network = lucid.config().network!;
  const ops = applyVaultOps(ctx.reserve.hash);
  const reward = rewardAddress(network, ops);
  const tx = await chained(
    lucid,
    lucid.newTx().register.Stake(reward, Data.void()).attach.CertificateValidator(ops.script),
  );
  return {
    name: "opsStake",
    tx,
    record: { scriptHash: ops.hash, rewardAddress: reward, registrationTx: tx.toHash() },
  };
}

export async function buildVault(lucid: LucidEvolution, ctx: VaultContext): Promise<Built> {
  const network = lucid.config().network!;
  if (!ctx.firstLossHash) throw new Error("vault genesis needs the first-loss hash");
  const ops = applyVaultOps(ctx.reserve.hash);
  const seed = await pickSeed(lucid);
  const vault = applyVault(seedOf(seed), ctx.reserve.hash, ops.hash);
  const params = {
    bounds: ctx.bounds,
    firstLossHash: ctx.firstLossHash,
    treasuryAddress: ctx.treasuryAddress,
  };
  const problems = vaultGenesisProblems(params, vault.hash);
  if (problems.length) throw new Error(`Vault genesis refused:\n  - ${problems.join("\n  - ")}`);
  const address = enterpriseAddress(network, vault);
  const tx = await chained(
    lucid,
    lucid
      .newTx()
      .collectFrom([seed])
      .mintAssets({ [vault.hash + THREAD_NAME]: 1n }, Data.void())
      .attach.MintingPolicy(vault.script)
      .pay.ToContract(
        address,
        { kind: "inline", value: vaultStateDatumCbor(params) },
        { lovelace: STATE_LOVELACE, [vault.hash + THREAD_NAME]: 1n },
      ),
  );
  ctx.vaultHash = vault.hash;
  return {
    name: "vault",
    tx,
    record: {
      seed: seedOf(seed),
      scriptHash: vault.hash,
      stsraPolicyId: vault.hash,
      stsraUnit: vault.hash + STSRA_NAME,
      address,
      stateUnit: vault.hash + THREAD_NAME,
      opsHash: ops.hash,
      firstLossHash: ctx.firstLossHash,
      treasuryAddress: ctx.treasuryAddress,
      bounds: ctx.bounds,
      genesisTx: tx.toHash(),
    },
  };
}

export async function buildSetVault(lucid: LucidEvolution, ctx: VaultContext): Promise<Built> {
  if (!ctx.vaultHash) throw new Error("SetVault needs the vault hash");
  if (!ctx.configUtxo?.datum) throw new Error("SetVault needs the genuine Config UTxO");
  if (!ctx.signers?.length) throw new Error("SetVault needs committee signers");
  const next = setVaultConfigDatum(ctx.configUtxo.datum, ctx.vaultHash);
  let b = lucid
    .newTx()
    .collectFrom([ctx.configUtxo], setVaultRedeemer(ctx.vaultHash))
    .attach.SpendingValidator(ctx.reserve.script)
    .pay.ToContract(ctx.reserveAddress, { kind: "inline", value: next }, ctx.configUtxo.assets);
  for (const s of ctx.signers) b = b.addSignerKey(s);
  const tx = await chained(lucid, b);
  return {
    name: "setVault",
    tx,
    record: {
      vaultPolicy: ctx.vaultHash,
      setVaultTx: tx.toHash(),
      signers: ctx.signers,
      configInput: `${ctx.configUtxo.txHash}#${String(ctx.configUtxo.outputIndex)}`,
    },
  };
}

export const BUILDERS: Record<StageName, (l: LucidEvolution, c: VaultContext) => Promise<Built>> = {
  firstLoss: buildFirstLoss,
  opsStake: buildOpsStake,
  vault: buildVault,
  setVault: buildSetVault,
};
