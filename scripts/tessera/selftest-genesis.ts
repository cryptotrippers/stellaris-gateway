/**
 * Self-test for the Tessera Reserve genesis builder. No network, no keys.
 *
 *   npx tsx scripts/tessera/selftest-genesis.ts
 *
 * Runs the REAL compiled reserve validator (contracts/tessera/plutus.json) on
 * Lucid's local Emulator:
 *   1. pure checks (parameter refusals, TSRA unit conversion, datum shapes);
 *   2. a full genesis: build → evaluate → sign → submit → read back the two
 *      UTxOs and compare every datum field and token;
 *   3. on-chain refusals: hand-built genesis variants the validator must reject
 *      (attested_at off the lower bound, threshold 1, a third token name,
 *      thread token sent to a wallet).
 * Exits non-zero on the first failure.
 */
import assert from "node:assert/strict";
import {
  Data,
  Emulator,
  Lucid,
  fromText,
  generateEmulatorAccount,
  getAddressDetails,
  slotToUnixTime,
  unixTimeToSlot,
  type LucidEvolution,
} from "@lucid-evolution/lucid";
import { applyReserve, enterpriseAddress } from "./lib/blueprint";
import { GENESIS_UTXO_LOVELACE, buildGenesis, type GenesisInput } from "./lib/build-genesis";
import {
  configDatumCbor,
  decodeReserveDatum,
  genesisProblems,
  supplyDatumCbor,
  tsraToUnits,
} from "./lib/genesis";

let passed = 0;
async function check(name: string, fn: () => unknown | Promise<unknown>) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    console.error(`  FAIL ${name}\n       ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}

const keyHash = (addr: string) => getAddressDetails(addr).paymentCredential!.hash;

async function main() {
  const operator = generateEmulatorAccount({ lovelace: 200_000_000n });
  const committee = [1, 2, 3, 4, 5].map(() => generateEmulatorAccount({ lovelace: 10_000_000n }));
  const emulator = new Emulator([operator, ...committee]);
  const lucid: LucidEvolution = await Lucid(emulator, "Custom");
  lucid.selectWallet.fromSeed(operator.seedPhrase);
  // The emulator starts at slot 0; move past the 2-minute lower-bound slack.
  emulator.awaitSlot(600);

  const input: GenesisInput = {
    operators: committee.map((c) => keyHash(c.address)),
    threshold: 3,
    mintCap: tsraToUnits("5000000"),
    attestedReserve: 0n,
    paused: false,
    kycMint: false,
    kycRedeem: false,
    kycStake: false,
  };

  console.log("pure checks");
  await check("tsraToUnits handles whole and 6-decimal amounts", () => {
    assert.equal(tsraToUnits("5000000"), 5_000_000_000_000n);
    assert.equal(tsraToUnits("12.5"), 12_500_000n);
    assert.throws(() => tsraToUnits("1.0000001"));
  });
  const elig = "00".repeat(28);
  await check("a valid 3-of-5 committee passes preflight", () =>
    assert.deepEqual(genesisProblems({ ...input, eligibilityPolicy: elig }), []),
  );
  await check("threshold 1 is refused", () =>
    assert.ok(genesisProblems({ ...input, threshold: 1, eligibilityPolicy: elig }).length),
  );
  await check("threshold above committee size is refused", () =>
    assert.ok(genesisProblems({ ...input, threshold: 6, eligibilityPolicy: elig }).length),
  );
  await check("duplicate operator is refused", () =>
    assert.ok(
      genesisProblems({
        ...input,
        operators: [input.operators[0]!, ...input.operators.slice(0, 4)],
        eligibilityPolicy: elig,
      }).length,
    ),
  );
  await check("mint_cap above the hard ceiling is refused", () =>
    assert.ok(
      genesisProblems({ ...input, mintCap: 1_000_000_000_000_001n, eligibilityPolicy: elig })
        .length,
    ),
  );
  await check("datums decode to the right constructors and field counts", () => {
    const p = { ...input, eligibilityPolicy: elig };
    assert.equal(decodeReserveDatum(configDatumCbor(p))?.kind, "config");
    assert.equal(decodeReserveDatum(supplyDatumCbor(p, 1_000))?.kind, "supply");
  });

  console.log("emulator genesis (real reserve validator)");
  const seed = (await lucid.wallet().getUtxos())[0]!;
  const plan = await buildGenesis(lucid, seed, input, emulator.now());

  await check("transaction fits the 16,384-byte limit", () => {
    const size = plan.tx.toCBOR().length / 2;
    console.log(`       tx size ${size} bytes`);
    assert.ok(size <= 16_384);
  });
  await check("eligibility policy is derived from the applied reserve hash", () =>
    assert.equal(plan.params.eligibilityPolicy, plan.eligibility.hash),
  );
  await check("reserve address is the enterprise address of the applied script", () => {
    const d = getAddressDetails(plan.reserveAddress);
    assert.equal(d.paymentCredential?.type, "Script");
    assert.equal(d.paymentCredential?.hash, plan.reserve.hash);
    assert.equal(d.stakeCredential, undefined);
  });

  const signed = await plan.tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  emulator.awaitBlock(1);
  await check("genesis tx confirmed", async () => assert.ok(await lucid.awaitTx(txHash)));

  const at = await lucid.utxosAt(plan.reserveAddress);
  await check("exactly two UTxOs at the reserve address", () => assert.equal(at.length, 2));
  const cfg = at.find((u) => (u.assets[plan.units.config] ?? 0n) === 1n);
  const sup = at.find((u) => (u.assets[plan.units.supply] ?? 0n) === 1n);
  await check("Config holds ADA + one `config` token only", () => {
    assert.ok(cfg);
    assert.deepEqual(Object.keys(cfg.assets).sort(), ["lovelace", plan.units.config].sort());
    assert.equal(cfg.assets.lovelace, GENESIS_UTXO_LOVELACE);
  });
  await check("Supply holds ADA + one `supply` token only", () => {
    assert.ok(sup);
    assert.deepEqual(Object.keys(sup.assets).sort(), ["lovelace", plan.units.supply].sort());
  });
  await check("Config datum matches the parameters", () => {
    const d = decodeReserveDatum(cfg!.datum!);
    assert.equal(d?.kind, "config");
    const f = d!.fields;
    assert.deepEqual(f[0], input.operators);
    assert.equal(f[1], 3n);
    assert.equal(f[6], plan.eligibility.hash);
    assert.equal(f[7], "");
    assert.equal(f[8], 0n);
    assert.equal(f[9], 0n);
  });
  await check("Supply datum is empty books with attested_at == lower bound", () => {
    const d = decodeReserveDatum(sup!.datum!);
    assert.equal(d?.kind, "supply");
    const f = d!.fields;
    assert.deepEqual(f, [0n, 0n, input.mintCap, 0n, BigInt(plan.attestedAt), 0n]);
  });
  await check("seed UTxO is spent", async () => {
    const left = await lucid.wallet().getUtxos();
    assert.ok(!left.some((u) => u.txHash === seed.txHash && u.outputIndex === seed.outputIndex));
  });

  console.log("on-chain refusals (validator must reject)");
  // Each variant uses a fresh seed so the only difference is the tampered field.
  async function tampered(
    mutate: (ctx: {
      tx: ReturnType<LucidEvolution["newTx"]>;
      addr: string;
      units: { config: string; supply: string; tsra: string };
      lo: number;
      p: Parameters<typeof configDatumCbor>[0];
    }) => ReturnType<LucidEvolution["newTx"]>,
  ) {
    const s = (await lucid.wallet().getUtxos()).find(
      (u) => (u.assets.lovelace ?? 0n) > 20_000_000n,
    )!;
    const reserve = applyReserve({ txHash: s.txHash, outputIndex: s.outputIndex });
    const addr = enterpriseAddress("Custom", reserve);
    const units = {
      config: reserve.hash + fromText("config"),
      supply: reserve.hash + fromText("supply"),
      tsra: reserve.hash + fromText("TSRA"),
    };
    const lo = slotToUnixTime("Custom", unixTimeToSlot("Custom", emulator.now() - 120_000));
    const p = { ...input, eligibilityPolicy: plan.eligibility.hash };
    const base = lucid
      .newTx()
      .collectFrom([s])
      .attach.MintingPolicy(reserve.script)
      .validFrom(lo)
      .validTo(lo + 3_600_000);
    return mutate({ tx: base, addr, units, lo, p }).complete();
  }
  const good = (c: Parameters<Parameters<typeof tampered>[0]>[0], supplyAt = c.lo, cfgP = c.p) =>
    c.tx.pay
      .ToContract(
        c.addr,
        { kind: "inline", value: configDatumCbor(cfgP) },
        {
          lovelace: 5_000_000n,
          [c.units.config]: 1n,
        },
      )
      .pay.ToContract(
        c.addr,
        { kind: "inline", value: supplyDatumCbor(c.p, supplyAt) },
        {
          lovelace: 5_000_000n,
          [c.units.supply]: 1n,
        },
      );

  await check("control: an untampered hand-built genesis is accepted", async () => {
    await tampered((c) =>
      good(c).mintAssets({ [c.units.config]: 1n, [c.units.supply]: 1n }, Data.void()),
    );
  });
  await check("attested_at one second after the lower bound is rejected", async () => {
    await assert.rejects(
      tampered((c) =>
        good(c, c.lo + 1_000).mintAssets(
          { [c.units.config]: 1n, [c.units.supply]: 1n },
          Data.void(),
        ),
      ),
    );
  });
  await check("a 1-key threshold is rejected on chain", async () => {
    await assert.rejects(
      tampered((c) =>
        good(c, c.lo, { ...c.p, threshold: 1 }).mintAssets(
          { [c.units.config]: 1n, [c.units.supply]: 1n },
          Data.void(),
        ),
      ),
    );
  });
  await check("minting TSRA alongside the thread tokens is rejected", async () => {
    await assert.rejects(
      tampered((c) =>
        good(c).mintAssets(
          { [c.units.config]: 1n, [c.units.supply]: 1n, [c.units.tsra]: 1n },
          Data.void(),
        ),
      ),
    );
  });
  await check("the `supply` token sent to a wallet is rejected", async () => {
    await assert.rejects(
      tampered((c) =>
        c.tx.pay
          .ToContract(
            c.addr,
            { kind: "inline", value: configDatumCbor(c.p) },
            {
              lovelace: 5_000_000n,
              [c.units.config]: 1n,
            },
          )
          .pay.ToAddress(operator.address, { lovelace: 5_000_000n, [c.units.supply]: 1n })
          .mintAssets({ [c.units.config]: 1n, [c.units.supply]: 1n }, Data.void()),
      ),
    );
  });

  console.log(`\n${passed} checks passed.`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
  process.exit(1);
});
