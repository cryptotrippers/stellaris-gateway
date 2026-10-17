/**
 * Operator script: withdraw a Position from a legacy yield_vault v3 instance
 * (AUDIT.md F-5). Preprod only.
 *
 *   npx tsx scripts/exit-yield-v3.ts                     # dry run (default)
 *   npx tsx scripts/exit-yield-v3.ts --asset sfm-01      # another v3 asset
 *   npx tsx scripts/exit-yield-v3.ts --submit            # sign + submit
 *
 * Since Stage 7 (2026-09-17) the app only knows the v4+ blueprints, so v3
 * UTxOs cannot be spent from the UI. This script is pinned to the FROZEN v3
 * blueprint in scripts/legacy/yield-v3.blueprint.json and refuses to run if:
 *   - that artifact's compiled code does not hash to the pinned v3 hashes;
 *   - the v3 address it derives is not the one recorded below;
 *   - the State's receipt policy is not the one it derives;
 *   - the State to spend against is ambiguous.
 *
 * Dry run (default): builds the complete transaction and evaluates both
 * scripts against it locally — the same check the ledger runs — then prints
 * the plan. Nothing is signed, written or submitted.
 *
 * --submit: additionally signs and submits. The signing key is read from the
 * environment, never from a file in the repo and never logged:
 *   STELLARIS_OPERATOR_SKEY_FILE  path to a cardano-cli payment .skey (JSON)
 *   STELLARIS_OPERATOR_SKEY       a bech32 ed25519_sk… key
 *   STELLARIS_OPERATOR_MNEMONIC   the wallet's seed phrase (account 0)
 * The key must be the Position owner's payment key; otherwise it refuses.
 *
 * One Position per transaction (the v3 validator enforces it, AUDIT.md V-03).
 */
import { existsSync, readFileSync } from "node:fs";
import {
  Blockfrost,
  CML,
  Constr,
  Data,
  Lucid,
  applyParamsToScript,
  fromText,
  getAddressDetails,
  validatorToAddress,
  validatorToScriptHash,
  type UTxO,
} from "@lucid-evolution/lucid";

const BF = "https://cardano-preprod.blockfrost.io/api/v0";
const ARTIFACT = "scripts/legacy/yield-v3.blueprint.json";
const V3_VERSION = 3n;
/** Unapplied hashes of the v3 build, as pinned in src/lib/yield-vault.ts at 19672af^. */
const PINNED = {
  yield: "e79ee0c4c5d5e0e29d095d616046cbcb9554ab6ba64b428236e11875",
  receipt: "ae6bf02ede5ed0aa23d619400208fca63f4dba372a69b7ae7e01862d",
};
/** v3 addresses recorded in the asset_vaults registry (live check, 2026-10-17). */
const V3_ADDRESSES: Record<string, string> = {
  "ph-solar-01": "addr_test1wr90lptvze45442wjj0zmlgnmtlexqldnahz3yp85hzyqtsqygj9m",
  "sfm-01": "addr_test1wq2uf7mxs9ajcqqtsvclvedzmst9amlkcylp7n9qdvjaccgr829tl",
  "sfm-02": "addr_test1wr8wwtqslhrypx33qqhwzavzg4prs2mq7ql0g3x5mvgfs3ch0htln",
};
/** v3 YieldRedeemer constructor index of `Withdraw { shares }`. */
const REDEEMER_WITHDRAW = 1;
/** Lovelace the State UTxO keeps so it satisfies min-ADA. */
const STATE_MIN_LOVELACE = 2_000_000n;

function die(msg: string): never {
  console.error(`[exit-yield-v3] ${msg}`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const SUBMIT = argv.includes("--submit");
const assetIdx = argv.indexOf("--asset");
const ASSET = assetIdx >= 0 ? (argv[assetIdx + 1] ?? "") : "ph-solar-01";

const KEY = process.env.BLOCKFROST_PREPROD_PROJECT_ID ?? "";
if (!KEY) die("BLOCKFROST_PREPROD_PROJECT_ID is not set in this shell.");
if (!KEY.startsWith("preprod"))
  die("BLOCKFROST_PREPROD_PROJECT_ID is not a Preprod key — refusing to run.");
if (!existsSync(ARTIFACT)) die(`${ARTIFACT} not found — run this from the repo root.`);
const expectedAddress = V3_ADDRESSES[ASSET];
if (!expectedAddress)
  die(`No recorded v3 instance for "${ASSET}". Known: ${Object.keys(V3_ADDRESSES).join(", ")}.`);

// ---------------------------------------------------------------------------
// Frozen v3 scripts, verified before anything else
// ---------------------------------------------------------------------------

const artifact = JSON.parse(readFileSync(ARTIFACT, "utf8")) as {
  validators: Array<{ title: string; hash: string; compiledCode: string }>;
};
function frozen(title: string, pinned: string): string {
  const v = artifact.validators.find((x) => x.title === title);
  if (!v) die(`${ARTIFACT} has no ${title}.`);
  const actual = validatorToScriptHash({ type: "PlutusV3", script: v.compiledCode });
  if (actual !== pinned || v.hash !== pinned) {
    die(`${title} in ${ARTIFACT} hashes to ${actual}, not the pinned v3 hash ${pinned}. Refusing.`);
  }
  return v.compiledCode;
}
const yieldCbor = applyParamsToScript(frozen("yield_vault.yield_vault.spend", PINNED.yield), [
  V3_VERSION,
  fromText(ASSET),
] as never);
const yieldScript = { type: "PlutusV3" as const, script: yieldCbor };
const yieldHash = validatorToScriptHash(yieldScript);
const vaultAddress = validatorToAddress("Preprod", yieldScript);
if (vaultAddress !== expectedAddress) {
  die(
    `The frozen v3 blueprint derives ${vaultAddress} for ${ASSET}, not the recorded ${expectedAddress}.`,
  );
}
const receiptCbor = applyParamsToScript(frozen("receipt.receipt.mint", PINNED.receipt), [
  yieldHash,
  fromText(ASSET),
] as never);
const receiptScript = { type: "PlutusV3" as const, script: receiptCbor };
const receiptPolicy = validatorToScriptHash(receiptScript);
const receiptUnit = receiptPolicy + fromText(ASSET);

// ---------------------------------------------------------------------------
// Chain state
// ---------------------------------------------------------------------------

interface V3State {
  totalShares: bigint;
  totalAssets: bigint;
  treasuryShares: bigint;
  receiptPolicy: string;
  fields: unknown[];
}

function decode(
  datum: string | null | undefined,
): { kind: "state"; s: V3State } | { kind: "position"; owner: string; shares: bigint } | null {
  if (!datum) return null;
  let d: unknown;
  try {
    d = Data.from(datum);
  } catch {
    return null;
  }
  if (!(d instanceof Constr)) return null;
  // v3 State: constructor 1 with 11 fields; Position: constructor 0 with 2.
  if (d.index === 1 && d.fields.length === 11) {
    const f = d.fields;
    return {
      kind: "state",
      s: {
        totalShares: f[0] as bigint,
        totalAssets: f[1] as bigint,
        treasuryShares: f[8] as bigint,
        receiptPolicy: f[10] as string,
        fields: f,
      },
    };
  }
  if (d.index === 0 && d.fields.length === 2) {
    return { kind: "position", owner: d.fields[0] as string, shares: d.fields[1] as bigint };
  }
  return null;
}

async function bf<T>(path: string): Promise<T | null> {
  const r = await fetch(BF + path, { headers: { project_id: KEY } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`Blockfrost ${path}: HTTP ${String(r.status)}`);
  return (await r.json()) as T;
}

/** floor(shares * assets / total), the whole pool when redeeming every share. */
function redeemValue(s: V3State, shares: bigint): bigint {
  if (shares <= 0n || s.totalShares <= 0n) return 0n;
  if (shares >= s.totalShares) return s.totalAssets;
  return (shares * s.totalAssets) / s.totalShares;
}

const ada = (l: bigint) => `${(Number(l) / 1e6).toFixed(6)} tADA`;

async function main(): Promise<void> {
  const lucid = await Lucid(new Blockfrost(BF, KEY), "Preprod");
  const utxos = await lucid.utxosAt(vaultAddress);

  const states = utxos.flatMap((u) => {
    const d = decode(u.datum);
    return d?.kind === "state" ? [{ u, s: d.s }] : [];
  });
  const positions = utxos.flatMap((u) => {
    const d = decode(u.datum);
    return d?.kind === "position" ? [{ u, owner: d.owner, shares: d.shares }] : [];
  });

  console.log(`== yield_vault v3 exit — ${ASSET} (${SUBMIT ? "SUBMIT" : "DRY RUN"}) ==`);
  console.log(`address:        ${vaultAddress}`);
  console.log(`script hash:    ${yieldHash}`);
  console.log(`receipt policy: ${receiptPolicy}`);
  console.log(
    `utxos: ${String(utxos.length)} (${String(states.length)} State, ${String(positions.length)} Position)`,
  );

  if (positions.length === 0) {
    console.log("\nNo Position at this v3 address — nothing to withdraw.");
    if (states.length) {
      const locked = states.reduce((a, x) => a + x.u.assets.lovelace, 0n);
      console.log(
        `${String(states.length)} State UTxO(s) hold ${ada(locked)} of min-ADA. v3 has no redeemer that ` +
          "closes a State, so that ADA cannot be recovered; it is not anyone's deposit.",
      );
    }
    return;
  }
  const position = positions[0]!;
  if (positions.length > 1) {
    console.log(
      `(${String(positions.length)} Positions found; this run exits the first. Re-run for the rest.)`,
    );
  }

  // The State to spend against must account for this Position's shares. A
  // duplicate empty bootstrap State (or a planted one) cannot.
  const candidates = states.filter(
    (x) => x.s.totalShares - x.s.treasuryShares >= position.shares && x.s.totalAssets > 0n,
  );
  if (candidates.length !== 1) {
    die(
      `Expected exactly one State able to cover ${String(position.shares)} shares, found ${String(candidates.length)}. Refusing to guess.`,
    );
  }
  const { u: stateUtxo, s: state } = candidates[0]!;
  if (state.receiptPolicy.toLowerCase() !== receiptPolicy) {
    die(
      `The State is bound to receipt policy ${state.receiptPolicy}, but the frozen v3 build derives ${receiptPolicy}.`,
    );
  }

  // Where the owner's receipts are: the wallet that must sign and receive.
  const holders =
    (await bf<Array<{ address: string; quantity: string }>>(`/assets/${receiptUnit}/addresses`)) ??
    [];
  const ownerHolders = holders.filter(
    (h) => getAddressDetails(h.address).paymentCredential?.hash === position.owner,
  );
  const held = ownerHolders.reduce((a, h) => a + BigInt(h.quantity), 0n);
  if (ownerHolders.length === 0 || held < position.shares) {
    die(
      `The owner (${position.owner}) holds ${String(held)} v3 receipts across their addresses; ` +
        `${String(position.shares)} must be burned. Move them back to one owner address first.`,
    );
  }
  const ownerAddress = ownerHolders.find((h) => BigInt(h.quantity) >= position.shares)?.address;
  if (!ownerAddress)
    die("The owner's receipts are split across addresses; consolidate them into one first.");

  // Accounting, exactly as the v3 validator recomputes it.
  const shares = position.shares;
  const gross = redeemValue(state, shares);
  const stateLovelace = stateUtxo.assets.lovelace;
  const available = stateLovelace + position.u.assets.lovelace - STATE_MIN_LOVELACE;
  const paid = gross < available ? gross : available;
  if (paid <= 0n) die("These shares redeem to nothing.");
  const nextStateLovelace = stateLovelace + position.u.assets.lovelace - paid;
  const nextFields = [...state.fields];
  nextFields[0] = state.totalShares - shares; // total_shares
  nextFields[1] = state.totalAssets - paid; // total_assets
  const nextState = Data.to(new Constr(1, nextFields) as never);

  // Wallet: the owner's address. Dry run reads it; submit signs as it.
  const ownerUtxos = await lucid.utxosAt(ownerAddress);
  if (SUBMIT) {
    const skeyFile = process.env.STELLARIS_OPERATOR_SKEY_FILE;
    const skey = process.env.STELLARIS_OPERATOR_SKEY;
    const mnemonic = process.env.STELLARIS_OPERATOR_MNEMONIC;
    if (skeyFile) {
      const j = JSON.parse(readFileSync(skeyFile, "utf8")) as { cborHex?: string };
      if (!j.cborHex?.startsWith("5820"))
        die("STELLARIS_OPERATOR_SKEY_FILE is not a cardano-cli payment .skey.");
      const key = CML.PrivateKey.from_normal_bytes(Buffer.from(j.cborHex.slice(4), "hex"));
      lucid.selectWallet.fromPrivateKey(key.to_bech32());
    } else if (skey) {
      lucid.selectWallet.fromPrivateKey(skey.trim());
    } else if (mnemonic) {
      lucid.selectWallet.fromSeed(mnemonic.trim());
    } else {
      die(
        "--submit needs STELLARIS_OPERATOR_SKEY_FILE, STELLARIS_OPERATOR_SKEY or STELLARIS_OPERATOR_MNEMONIC.",
      );
    }
    const walletAddress = await lucid.wallet().address();
    if (getAddressDetails(walletAddress).paymentCredential?.hash !== position.owner) {
      die("The signing key is not the Position owner's payment key. Refusing to sign.");
    }
  } else {
    lucid.selectWallet.fromAddress(ownerAddress, ownerUtxos);
  }

  const receiptInputs = ownerUtxos.filter((u: UTxO) => (u.assets[receiptUnit] ?? 0n) > 0n);
  const voidRedeemer = Data.to(new Constr(0, []) as never);
  const tx = await lucid
    .newTx()
    .collectFrom([stateUtxo, position.u], Data.to(new Constr(REDEEMER_WITHDRAW, [shares]) as never))
    .attach.SpendingValidator(yieldScript)
    .collectFrom(receiptInputs)
    .mintAssets({ [receiptUnit]: -shares }, voidRedeemer)
    .attach.MintingPolicy(receiptScript)
    .pay.ToContract(
      vaultAddress,
      { kind: "inline", value: nextState },
      { lovelace: nextStateLovelace },
    )
    .pay.ToAddress(ownerAddress, { lovelace: paid })
    .addSignerKey(position.owner)
    .complete();

  const body = CML.Transaction.from_cbor_hex(tx.toCBOR()).body();
  console.log("\nPlan (validated: both scripts evaluated successfully against this exact tx)");
  console.log(
    `  spend State     ${stateUtxo.txHash}#${String(stateUtxo.outputIndex)}  (${ada(stateLovelace)})`,
  );
  console.log(
    `  spend Position  ${position.u.txHash}#${String(position.u.outputIndex)}  (${ada(position.u.assets.lovelace)}, ${String(shares)} shares)`,
  );
  console.log(`  burn receipts   ${String(shares)} × ${receiptUnit}`);
  console.log(`  pay owner       ${ada(paid)} -> ${ownerAddress}`);
  console.log(
    `  State after     total_shares=${String(nextFields[0])} total_assets=${String(nextFields[1])}, ${ada(nextStateLovelace)}`,
  );
  console.log(`  fee             ${ada(body.fee())}`);
  console.log(`  tx hash         ${tx.toHash()}`);

  if (!SUBMIT) {
    console.log(
      "\nDRY RUN — nothing was signed or submitted. Re-run with --submit and a signing key to execute.",
    );
    return;
  }
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log(`\nSubmitted: ${txHash}\nhttps://preprod.cardanoscan.io/transaction/${txHash}`);
}

main().catch((e: unknown) => {
  console.error(`[exit-yield-v3] ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
