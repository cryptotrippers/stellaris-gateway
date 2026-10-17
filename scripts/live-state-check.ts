/**
 * Read-only Preprod inventory of every Stellaris script address.
 *
 *   npx tsx scripts/live-state-check.ts [--assets sfm-01,ph-solar-01] [--no-registry]
 *
 * Derives addresses and policy ids from the COMMITTED blueprints
 * (contracts/<project>/plutus.json) plus the version constants pinned in
 * src/lib/*.ts, then asks Blockfrost what sits at each one: UTxO count, ADA and
 * native-token totals, and every inline datum decoded against the blueprint's
 * own datum schema (constructor + field names). Policies (receipt, fraction,
 * sUSDr) have no address, so their circulating supply is reported instead.
 *
 * Asset ids come from --assets, the defaults below, and — unless --no-registry —
 * the public Supabase registry (`asset_vaults`, `offerings`, anon SELECT), whose
 * recorded script addresses are also scanned. A registry address the current
 * blueprint does not derive was bootstrapped under an older build; it is listed
 * so funds there are not missed.
 *
 * Phase 1 (AUDIT.md F-1): yield_vault, multi_asset_vault and fraction_vault are
 * parameterised by a bootstrap seed, so only instances pinned in
 * src/lib/vault-instances.ts can be derived; unpinned ones are reported as "not
 * bootstrapped". At those addresses each State/Offering is labelled GENUINE
 * (carries the state-thread token) or PLANTED (does not; inert on-chain).
 *
 * Safety: GET requests only. No transactions, no signing, no writes to disk,
 * chain or database. Refuses to run with a non-Preprod Blockfrost key.
 */
import { existsSync, readFileSync } from "node:fs";
import {
  Constr,
  Data,
  applyParamsToScript,
  fromText,
  mintingPolicyToId,
  validatorToAddress,
  validatorToScriptHash,
} from "@lucid-evolution/lucid";
import {
  MULTI_VAULT_SEEDS,
  OFFERING_SEEDS,
  THREAD_TOKEN_NAME_HEX,
  YIELD_VAULT_SEEDS,
  type VaultSeed,
} from "../src/lib/vault-instances";

const BF = "https://cardano-preprod.blockfrost.io/api/v0";
const DEFAULT_ASSETS = ["sfm-01", "sfm-02", "ph-solar-01"];
/** Pause between Blockfrost calls; the free tier allows 10 req/s. */
const BF_DELAY_MS = 120;

/** Setup-phase failure: nothing is in flight yet, so exiting immediately is safe. */
function die(msg: string): never {
  console.error(`[live-state-check] ${msg}`);
  process.exit(2);
}

/**
 * Network-phase failure. Calling process.exit() while fetch handles are open
 * trips a libuv assertion on Windows, so unwind to `main` and let Node exit.
 */
class Abort extends Error {}
function abort(msg: string): never {
  throw new Abort(msg);
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

const KEY = process.env.BLOCKFROST_PREPROD_PROJECT_ID ?? "";
if (!KEY) die("BLOCKFROST_PREPROD_PROJECT_ID is not set in this shell.");
if (!KEY.startsWith("preprod"))
  die("BLOCKFROST_PREPROD_PROJECT_ID is not a Preprod key — refusing to run.");
if (!existsSync("contracts/vault/plutus.json")) die("Run this from the repo root.");

const argv = process.argv.slice(2);
const useRegistry = !argv.includes("--no-registry");
const assetsArg = argv.indexOf("--assets");
const cliAssets =
  assetsArg >= 0 && argv[assetsArg + 1]
    ? argv[assetsArg + 1]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

function versionPin(name: string, files: string[]): bigint {
  const re = new RegExp(`export const ${name}\\s*=\\s*(\\d+)n`);
  for (const f of files) {
    if (!existsSync(f)) continue;
    const m = readFileSync(f, "utf8").match(re);
    if (m) return BigInt(m[1]);
  }
  die(`could not find 'export const ${name} = <n>n' in any of: ${files.join(", ")}`);
}

const VERSIONS = {
  vault: versionPin("VAULT_VERSION", ["src/lib/vault-params.ts", "src/lib/vault.ts"]),
  yield: versionPin("YIELD_VAULT_VERSION", ["src/lib/yield-vault.ts"]),
  multi: versionPin("MULTI_VAULT_VERSION", ["src/lib/multi-asset-vault.ts"]),
  fraction: versionPin("FRACTION_VAULT_VERSION", ["src/lib/fraction-vault.ts"]),
  susdr: versionPin("SUSDR_VAULT_VERSION", ["src/lib/susdr-vault.ts"]),
};

// ---------------------------------------------------------------------------
// Blueprints and their datum schemas
// ---------------------------------------------------------------------------

type Project = "vault" | "fraction-vault" | "multi-asset-vault" | "susdr-vault";

interface SchemaCtor {
  title: string;
  index: number;
  fields: string[];
}

interface Blueprint {
  validators: Array<{
    title: string;
    compiledCode?: string;
    datum?: { schema?: { $ref?: string } };
  }>;
  definitions: Record<string, { anyOf?: SchemaCtorRaw[] } & Partial<SchemaCtorRaw>>;
}

interface SchemaCtorRaw {
  title: string;
  index: number;
  fields?: Array<{ title?: string }>;
}

const blueprints = {} as Record<Project, Blueprint>;
for (const p of ["vault", "fraction-vault", "multi-asset-vault", "susdr-vault"] as Project[]) {
  const path = `contracts/${p}/plutus.json`;
  if (!existsSync(path)) die(`${path} is missing.`);
  blueprints[p] = JSON.parse(readFileSync(path, "utf8")) as Blueprint;
}

function code(p: Project, title: string): string {
  const v = blueprints[p].validators.find((x) => x.title === title);
  if (!v?.compiledCode) die(`contracts/${p}/plutus.json has no compiledCode for '${title}'.`);
  return v.compiledCode;
}

/** Constructors of the datum type a spend validator declares, from the blueprint. */
function datumSchema(p: Project, title: string): SchemaCtor[] {
  const v = blueprints[p].validators.find((x) => x.title === title);
  const ref = v?.datum?.schema?.$ref;
  if (!ref) return [];
  const key = ref.replace("#/definitions/", "").replace(/~1/g, "/");
  const def = blueprints[p].definitions[key];
  if (!def) return [];
  const ctors = def.anyOf ?? [def as SchemaCtorRaw];
  return ctors.map((c) => ({
    title: c.title,
    index: c.index,
    fields: (c.fields ?? []).map((f, i) => f.title ?? `field${String(i)}`),
  }));
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

interface AddressTarget {
  labels: string[];
  address: string;
  scriptHash: string | null;
  schema: SchemaCtor[];
  derived: boolean;
  /** State-thread token unit for seed-parameterised instances, else null. */
  threadUnit: string | null;
}

interface PolicyTarget {
  label: string;
  unit: string;
}

const addresses = new Map<string, AddressTarget>();
const policies: PolicyTarget[] = [];

function addAddress(
  label: string,
  address: string,
  scriptHash: string | null,
  schema: SchemaCtor[],
  derived: boolean,
  threadUnit: string | null = null,
) {
  const existing = addresses.get(address);
  if (existing) {
    existing.labels.push(label);
    if (!existing.schema.length) existing.schema = schema;
    existing.derived ||= derived;
    existing.threadUnit ??= threadUnit;
    return;
  }
  addresses.set(address, { labels: [label], address, scriptHash, schema, derived, threadUnit });
}

/** Plutus data for an Aiken OutputReference seed parameter. */
const seedData = (seed: VaultSeed) => new Constr(0, [seed.txHash, BigInt(seed.outputIndex)]);

/** Instances with no pinned seed: they have no address yet. */
const notBootstrapped: string[] = [];

function applied(p: Project, title: string, params: unknown[]) {
  const script = applyParamsToScript(code(p, title), params as never);
  const v = { type: "PlutusV3" as const, script };
  return { hash: validatorToScriptHash(v), address: validatorToAddress("Preprod", v), script };
}

interface RegistryRow {
  asset_id: string;
  vault_version: number;
  script_address: string;
  network?: string;
  fraction_policy_id?: string;
  fraction_asset_name_hex?: string;
}

interface Registry {
  vaults: RegistryRow[];
  offerings: RegistryRow[];
  /** False when either table could not be read — older-blueprint addresses were NOT scanned. */
  ok: boolean;
}

/**
 * Shell env (SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY) wins over the tracked
 * `.env`, so the registry can be pointed at the live project without editing
 * a tracked file.
 */
async function readRegistry(): Promise<Registry> {
  const env: Record<string, string> = {};
  if (existsSync(".env")) {
    for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
      if (m) env[m[1]] = m[2];
    }
  }
  const url = process.env.SUPABASE_URL || env.SUPABASE_URL || env.VITE_SUPABASE_URL;
  const key =
    process.env.SUPABASE_PUBLISHABLE_KEY ||
    env.SUPABASE_PUBLISHABLE_KEY ||
    env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) {
    const missing = [!url && "SUPABASE_URL", !key && "SUPABASE_PUBLISHABLE_KEY"].filter(Boolean);
    console.warn(
      `[registry] ${missing.join(" and ")} not set (shell env, or .env / VITE_ equivalent) — skipped`,
    );
    return { vaults: [], offerings: [], ok: false };
  }
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  })();
  let ok = true;
  const get = async (q: string): Promise<RegistryRow[]> => {
    const table = q.split("?")[0];
    try {
      const r = await fetch(`${url}/rest/v1/${q}`, {
        headers: { apikey: key, Authorization: `Bearer ${key}` },
      });
      if (!r.ok) {
        console.warn(`[registry] ${table}: HTTP ${String(r.status)} — skipped`);
        ok = false;
        return [];
      }
      return (await r.json()) as RegistryRow[];
    } catch (e) {
      const err = e as Error & { cause?: { code?: string } };
      const code = err.cause?.code ?? err.message;
      const why =
        code === "ENOTFOUND"
          ? `host ${host} does not resolve — SUPABASE_URL is wrong or that project no longer exists`
          : code;
      console.warn(`[registry] ${table}: ${why} — skipped`);
      ok = false;
      return [];
    }
  };
  const vaults = await get("asset_vaults?select=asset_id,vault_version,script_address,network");
  const offerings = await get(
    "offerings?select=asset_id,vault_version,script_address,network,fraction_policy_id,fraction_asset_name_hex",
  );
  return { vaults, offerings, ok };
}

// ---------------------------------------------------------------------------
// Blockfrost
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function bf<T>(path: string): Promise<{ status: number; body: T | null }> {
  await sleep(BF_DELAY_MS);
  const r = await fetch(BF + path, { headers: { project_id: KEY } });
  if (r.status === 401 || r.status === 403)
    abort(`Blockfrost rejected the key (HTTP ${String(r.status)}).`);
  if (r.status === 429) abort("Blockfrost rate limit hit (HTTP 429) — wait a minute and re-run.");
  if (!r.ok) return { status: r.status, body: null };
  return { status: r.status, body: (await r.json()) as T };
}

interface BfUtxo {
  tx_hash: string;
  output_index: number;
  amount: Array<{ unit: string; quantity: string }>;
  inline_datum: string | null;
  data_hash: string | null;
}

async function utxosAt(address: string): Promise<BfUtxo[] | string> {
  const all: BfUtxo[] = [];
  for (let page = 1; ; page++) {
    const r = await bf<BfUtxo[]>(`/addresses/${address}/utxos?count=100&page=${String(page)}`);
    if (r.status === 404) return all;
    if (!r.body) return `HTTP ${String(r.status)}`;
    all.push(...r.body);
    if (r.body.length < 100) return all;
  }
}

// ---------------------------------------------------------------------------
// Datum rendering
// ---------------------------------------------------------------------------

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

function plain(d: unknown): Json {
  if (typeof d === "bigint") return d.toString();
  if (typeof d === "string") return d;
  if (d instanceof Constr) return { constructor: d.index, fields: d.fields.map(plain) };
  if (d instanceof Map) return [...d.entries()].map(([k, v]) => [plain(k), plain(v)] as Json);
  if (Array.isArray(d)) return d.map(plain);
  return String(d);
}

interface DecodedDatum {
  name: string;
  matchesSchema: boolean;
  value: Json;
}

function decodeDatum(hex: string, schema: SchemaCtor[]): DecodedDatum {
  let raw: unknown;
  try {
    raw = Data.from(hex);
  } catch {
    return { name: "undecodable", matchesSchema: false, value: hex.slice(0, 80) };
  }
  if (!(raw instanceof Constr))
    return { name: "non-constructor", matchesSchema: false, value: plain(raw) };
  const byIndex = schema.find((c) => c.index === raw.index);
  if (byIndex && byIndex.fields.length === raw.fields.length) {
    const named: { [k: string]: Json } = {};
    byIndex.fields.forEach((f, i) => (named[f] = plain(raw.fields[i])));
    return { name: byIndex.title, matchesSchema: true, value: named };
  }
  const expected = byIndex
    ? ` (blueprint ${byIndex.title} has ${String(byIndex.fields.length)})`
    : "";
  return {
    name: `constr#${String(raw.index)} with ${String(raw.fields.length)} fields${expected}`,
    matchesSchema: false,
    value: plain(raw),
  };
}

const isStateName = (name: string) => /State|Offering/.test(name);

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const registry: Registry = useRegistry
    ? await readRegistry()
    : { vaults: [], offerings: [], ok: true };
  const assetIds = [
    ...new Set([
      ...DEFAULT_ASSETS,
      ...cliAssets,
      ...registry.vaults.map((r) => r.asset_id),
      ...registry.offerings.map((r) => r.asset_id),
    ]),
  ];

  const yieldSchema = datumSchema("vault", "yield_vault.yield_vault.spend");
  const vaultSchema = datumSchema("vault", "vault.vault.spend");
  const multiSchema = datumSchema("multi-asset-vault", "multi_asset_vault.multi_asset_vault.spend");
  const fractionSchema = datumSchema("fraction-vault", "fraction_vault.fraction_vault.spend");
  const susdrSchema = datumSchema("susdr-vault", "susdr_vault.susdr_vault.spend");

  for (const assetId of assetIds) {
    const name = fromText(assetId);

    // Stage 3 vault: every version up to the pinned one stays spendable (AUDIT V-08).
    for (let v = 1n; v <= VERSIONS.vault; v++) {
      const a = applied("vault", "vault.vault.spend", [v, name]);
      addAddress(`vault v${String(v)} / ${assetId}`, a.address, a.hash, vaultSchema, true);
    }

    const yieldSeed = YIELD_VAULT_SEEDS[assetId];
    if (yieldSeed) {
      const y = applied("vault", "yield_vault.yield_vault.spend", [
        VERSIONS.yield,
        name,
        seedData(yieldSeed),
      ]);
      addAddress(
        `yield_vault v${String(VERSIONS.yield)} / ${assetId}`,
        y.address,
        y.hash,
        yieldSchema,
        true,
        y.hash + THREAD_TOKEN_NAME_HEX,
      );
      const receiptScript = applyParamsToScript(code("vault", "receipt.receipt.mint"), [
        y.hash,
        name,
      ] as never);
      const receiptPolicy = mintingPolicyToId({ type: "PlutusV3", script: receiptScript });
      policies.push({ label: `receipt / ${assetId}`, unit: receiptPolicy + name });
    } else {
      notBootstrapped.push(`yield_vault v${String(VERSIONS.yield)} / ${assetId}`);
    }

    // ADA-denominated instances; other units need their (policy, name) pair.
    const multiSeed = MULTI_VAULT_SEEDS[`${assetId}:`];
    if (multiSeed) {
      const m = applied("multi-asset-vault", "multi_asset_vault.multi_asset_vault.spend", [
        VERSIONS.multi,
        name,
        "",
        "",
        seedData(multiSeed),
      ]);
      addAddress(
        `multi_asset_vault v${String(VERSIONS.multi)} / ${assetId} / ADA`,
        m.address,
        m.hash,
        multiSchema,
        true,
        m.hash + THREAD_TOKEN_NAME_HEX,
      );
    } else {
      notBootstrapped.push(`multi_asset_vault v${String(VERSIONS.multi)} / ${assetId} / ADA`);
    }

    const offeringSeed = OFFERING_SEEDS[`${assetId}:`];
    if (offeringSeed) {
      const f = applied("fraction-vault", "fraction_vault.fraction_vault.spend", [
        VERSIONS.fraction,
        name,
        "",
        "",
        seedData(offeringSeed),
      ]);
      addAddress(
        `fraction_vault v${String(VERSIONS.fraction)} / ${assetId} / ADA`,
        f.address,
        f.hash,
        fractionSchema,
        true,
        f.hash + THREAD_TOKEN_NAME_HEX,
      );
      const fractionScript = applyParamsToScript(code("fraction-vault", "fraction.fraction.mint"), [
        f.hash,
        name,
      ] as never);
      const fractionPolicy = mintingPolicyToId({ type: "PlutusV3", script: fractionScript });
      policies.push({ label: `fraction / ${assetId} / ADA`, unit: fractionPolicy + name });
    } else {
      notBootstrapped.push(`fraction_vault v${String(VERSIONS.fraction)} / ${assetId} / ADA`);
    }
  }

  const s = applied("susdr-vault", "susdr_vault.susdr_vault.spend", [VERSIONS.susdr]);
  addAddress(`susdr_vault v${String(VERSIONS.susdr)}`, s.address, s.hash, susdrSchema, true);
  policies.push({
    label: `sUSDr share token v${String(VERSIONS.susdr)}`,
    unit: s.hash + fromText("sUSDr"),
  });

  for (const r of registry.vaults) {
    addAddress(
      `registry asset_vaults: ${r.asset_id} v${String(r.vault_version)} (${r.network ?? "?"})`,
      r.script_address,
      null,
      yieldSchema,
      false,
    );
  }
  for (const r of registry.offerings) {
    addAddress(
      `registry offerings: ${r.asset_id} v${String(r.vault_version)} (${r.network ?? "?"})`,
      r.script_address,
      null,
      fractionSchema,
      false,
    );
    if (r.fraction_policy_id && r.fraction_asset_name_hex) {
      const unit = r.fraction_policy_id + r.fraction_asset_name_hex;
      if (!policies.some((p) => p.unit === unit))
        policies.push({ label: `registry fraction / ${r.asset_id}`, unit });
    }
  }

  console.log("== Stellaris live-state check (Preprod, read-only) ==");
  console.log(
    `versions: vault ${String(VERSIONS.vault)}, yield ${String(VERSIONS.yield)}, multi ${String(VERSIONS.multi)}, ` +
      `fraction ${String(VERSIONS.fraction)}, susdr ${String(VERSIONS.susdr)}`,
  );
  console.log(`assets: ${assetIds.join(", ")}`);
  if (notBootstrapped.length) {
    console.log(
      `not bootstrapped (no seed pinned in src/lib/vault-instances.ts): ${notBootstrapped.join("; ")}`,
    );
  }
  console.log(
    `registry: ${useRegistry ? `${String(registry.vaults.length)} asset_vaults, ${String(registry.offerings.length)} offerings` : "skipped"}\n`,
  );

  const flags: string[] = [];
  if (!registry.ok) {
    flags.push(
      "registry unreadable — addresses from OLDER blueprints (e.g. earlier yield v3/v4 builds) were NOT scanned",
    );
  }
  let funded = 0;

  for (const t of addresses.values()) {
    const utxos = await utxosAt(t.address);
    const header = `${t.labels.join("\n  aka ")}\n  addr: ${t.address}${t.scriptHash ? `\n  hash: ${t.scriptHash}` : ""}`;
    if (typeof utxos === "string") {
      console.log(`${header}\n  ERROR reading UTxOs: ${utxos}\n`);
      flags.push(`${t.labels[0]}: could not read UTxOs (${utxos})`);
      continue;
    }
    if (utxos.length === 0) {
      console.log(`${header}\n  utxos: 0\n`);
      continue;
    }
    funded++;

    const totals = new Map<string, bigint>();
    const kinds = new Map<string, number>();
    const states: Array<{ ref: string; d: DecodedDatum; genuine: boolean | null }> = [];
    let noDatum = 0;
    for (const u of utxos) {
      for (const a of u.amount) totals.set(a.unit, (totals.get(a.unit) ?? 0n) + BigInt(a.quantity));
      if (!u.inline_datum) {
        noDatum++;
        continue;
      }
      const d = decodeDatum(u.inline_datum, t.schema);
      kinds.set(d.name, (kinds.get(d.name) ?? 0) + 1);
      if (isStateName(d.name) || !d.matchesSchema) {
        const unit = t.threadUnit;
        const genuine =
          unit === null ? null : (u.amount.find((a) => a.unit === unit)?.quantity ?? "0") === "1";
        states.push({ ref: `${u.tx_hash}#${String(u.output_index)}`, d, genuine });
      }
    }

    const lovelace = totals.get("lovelace") ?? 0n;
    totals.delete("lovelace");
    console.log(header);
    console.log(`  utxos: ${String(utxos.length)} | ADA: ${(Number(lovelace) / 1e6).toFixed(6)}`);
    for (const [unit, q] of totals) console.log(`  token ${unit}: ${q.toString()}`);
    const kindList = [...kinds.entries()].map(([k, n]) => `${k} x${String(n)}`);
    if (noDatum) kindList.push(`no inline datum x${String(noDatum)}`);
    console.log(`  datums: ${kindList.join(", ")}`);
    for (const st of states) {
      const tag =
        st.genuine === null ? "" : st.genuine ? " [GENUINE]" : " [PLANTED — no state token]";
      console.log(`  ${st.d.name}${tag} @ ${st.ref}\n    ${JSON.stringify(st.d.value)}`);
    }
    console.log("");

    const stateLike = states.filter((x) => isStateName(x.d.name));
    if (t.threadUnit !== null) {
      const genuine = stateLike.filter((x) => x.genuine).length;
      const planted = stateLike.length - genuine;
      if (genuine > 1)
        flags.push(
          `${t.labels[0]}: ${String(genuine)} UTxOs carry the state token — impossible on-chain, investigate`,
        );
      if (planted > 0)
        flags.push(
          `${t.labels[0]}: ${String(planted)} planted State/Offering UTxO(s) without the state token (inert)`,
        );
      if (genuine === 0)
        flags.push(
          `${t.labels[0]}: pinned instance has UTxOs but no GENUINE state — seed may be wrong`,
        );
    } else if (stateLike.length > 1) {
      flags.push(
        `${t.labels[0]}: ${String(stateLike.length)} State/Offering UTxOs at a pre-Phase-1 address — ambiguous (planted or duplicate bootstrap)`,
      );
    }
    const off = states.filter((x) => !x.d.matchesSchema);
    if (off.length)
      flags.push(
        `${t.labels[0]}: ${String(off.length)} datum(s) do not match the current blueprint schema`,
      );
    if (!t.derived)
      flags.push(
        `${t.labels[0]}: registry address not derived from the current blueprint (older build) — holds ${(Number(lovelace) / 1e6).toFixed(6)} ADA`,
      );
  }

  console.log("== Policies (circulating supply) ==");
  for (const p of policies) {
    const r = await bf<{ quantity: string }>(`/assets/${p.unit}`);
    const q =
      r.status === 404 ? "never minted" : r.body ? r.body.quantity : `HTTP ${String(r.status)}`;
    console.log(`${p.label}\n  unit: ${p.unit}\n  supply: ${q}`);
  }

  console.log(
    `\n== Summary: ${String(addresses.size)} addresses scanned, ${String(funded)} hold UTxOs ==`,
  );
  if (flags.length) for (const f of flags) console.log(`FLAG ${f}`);
  else console.log("No flags.");
}

main().catch((e: unknown) => {
  if (e instanceof Abort) {
    console.error(`[live-state-check] ${e.message}`);
    process.exitCode = 2;
  } else {
    console.error(e);
    process.exitCode = 1;
  }
});
