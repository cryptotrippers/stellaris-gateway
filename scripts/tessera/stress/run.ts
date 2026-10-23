/**
 * Phase 2.8 stress run. Deterministic (fixed seed, no clock, no network).
 *
 *   npx tsx scripts/tessera/stress/run.ts
 *
 * Writes docs/tessera-stress-2-8.md and docs/tessera-stress-2-8.results.json.
 * See the report for assumptions; model.ts / rules.ts for the rules replayed.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { defaults, simulate, type Params, type Result } from "./model";
import { limitFloor, TSRA } from "./rules";

const OUT_MD = "docs/tessera-stress-2-8.md";
const OUT_JSON = "docs/tessera-stress-2-8.results.json";

// -- scenarios (share of the initial TVL asked for on each day) ---------------------
const SCEN: Record<string, { name: string; profile: number[] }> = {
  a: { name: "(a) 10% a day for 5 days", profile: Array(5).fill(0.1) },
  b: { name: "(b) 30% in one day", profile: [0.3] },
  c: { name: "(c) 50% over 7 days", profile: Array(7).fill(0.5 / 7) },
  d: { name: "(d) 3% a day for 30 days", profile: Array(30).fill(0.03) },
};
const KEYS = Object.keys(SCEN);
const TVLS = [500_000, 1_000_000, 2_500_000, 5_000_000];

const base = (over: Partial<Params> = {}): Params => ({ ...defaults(), ...over });
const run = (k: string, over: Partial<Params> = {}): Result =>
  simulate(base({ profile: SCEN[k]!.profile, ...over }));
const allPass = (over: Partial<Params>) => KEYS.every((k) => run(k, over).pass);
/** The run's start day within the 30-day limit block matters once limits are static: judge on all alignments. */
const ALIGN = [0, 5, 10, 15, 20, 25, 29];
const allPassAligned = (over: Partial<Params>) =>
  ALIGN.every((sd) => allPass({ ...over, startDay: sd }));
const worstAligned = (over: Partial<Params>) =>
  Math.max(...ALIGN.map((sd) => worst({ ...over, startDay: sd })));
const worst = (over: Partial<Params>) => Math.max(...KEYS.map((k) => run(k, over).maxWaitDays));

// -- committee cases ---------------------------------------------------------------
const CASES: { id: string; label: string; over: Partial<Params> }[] = [
  { id: "deployed", label: "limits as deployed (no raise)", over: { raiseAfterH: null } },
  {
    id: "h12",
    label: "raise after 12 h (optimistic)",
    over: { raiseAfterH: 12, fundCadenceH: 12 },
  },
  { id: "h24", label: "raise after 24 h (BASE)", over: { raiseAfterH: 24, fundCadenceH: 24 } },
  {
    id: "h48",
    label: "raise after 48 h (pessimistic)",
    over: { raiseAfterH: 48, fundCadenceH: 48 },
  },
];

// -- formatting --------------------------------------------------------------------
const n0 = (x: number) => Math.round(x).toLocaleString("en-AU");
const d2 = (x: number) => x.toFixed(2);
const M = (x: number) => `${x / 1e6}M`;
const pct = (x: number) => `${(x * 100).toFixed((x * 100) % 1 ? 1 : 0)}%`;
const ok = (b: boolean) => (b ? "pass" : "FAIL");
function table(head: string[], rows: (string | number)[][]): string {
  const line = (r: (string | number)[]) => `| ${r.join(" | ")} |`;
  return [line(head), line(head.map(() => "---")), ...rows.map(line)].join("\n");
}

// -- searches ----------------------------------------------------------------------
/** Smallest x in [lo, hi] (geometric bisection, 1%) with pred(x) true; null if pred(hi) is false. */
function minPassing(lo: number, hi: number, pred: (x: number) => boolean): number | null {
  if (pred(lo)) return lo;
  if (!pred(hi)) return null;
  while (hi / lo > 1.01) {
    const mid = Math.sqrt(lo * hi);
    if (pred(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}
const round3 = (x: number) => {
  const m = 10 ** Math.max(0, Math.floor(Math.log10(x)) - 2);
  return Math.ceil(x / m) * m;
};

const json: Record<string, unknown> = {
  generatedBy: "scripts/tessera/stress/run.ts",
  seed: defaults().seed,
  baseParams: { ...defaults(), profile: undefined },
  scenarios: Object.fromEntries(KEYS.map((k) => [k, SCEN[k]!])),
};
const md: string[] = [];

// ===================================================================================
// 1. main grid
// ===================================================================================
const grid: Record<string, unknown>[] = [];
const gridMd: string[] = [];
for (const c of CASES) {
  const rows: (string | number)[][] = [];
  for (const k of KEYS)
    for (const tvl of TVLS) {
      const r = run(k, { ...c.over, tvl });
      grid.push({ case: c.id, scenario: k, tvl, ...r });
      rows.push([
        SCEN[k]!.name,
        M(tvl),
        d2(r.maxWaitDays),
        n0(r.peakQueue),
        d2(r.shortDays),
        r.unpaid > 0 ? n0(r.unpaid) : "0",
        ok(r.pass),
      ]);
    }
  gridMd.push(
    `#### ${c.label}\n\n` +
      table(
        [
          "scenario",
          "TVL",
          "max queue age (d)",
          "peak queue (TSRA)",
          "days in short mode",
          "unpaid at end",
          "7-day",
        ],
        rows,
      ),
  );
}
json.mainGrid = grid;

// gate
const gate = CASES.map((c) => ({
  id: c.id,
  ...Object.fromEntries(KEYS.map((k) => [k, run(k, { ...c.over, tvl: 5_000_000 })])),
}));
const gate5 = KEYS.map((k) => run(k, { ...CASES[2]!.over, tvl: 5_000_000 }));
const gatePass = gate5.every((r) => r.pass);
json.gate5M = {
  case: "h24",
  pass: gatePass,
  perScenario: Object.fromEntries(KEYS.map((k, i) => [k, gate5[i]])),
};
void gate;

// ===================================================================================
// 2. loss events (e): worst wait, not gated
// ===================================================================================
const lossRows: (string | number)[][] = [];
const lossJson: unknown[] = [];
for (const tvl of [1_000_000, 5_000_000])
  for (const k of KEYS)
    for (const lossPct of [0.02, 0.05])
      for (const fl of [0, 0.03]) {
        const dem = SCEN[k]!.profile.length;
        const r = run(k, {
          tvl,
          flPct: fl,
          loss: { pct: lossPct, atDay: dem / 2, freezeDays: 3 },
          raiseAfterH: 24,
        });
        lossJson.push({ tvl, scenario: k, lossPct, flPct: fl, freezeDays: 3, ...r });
        lossRows.push([
          SCEN[k]!.name,
          M(tvl),
          pct(lossPct),
          pct(fl),
          d2(r.maxWaitDays),
          n0(r.unpaid),
          r.sleeveExhausted ? "yes" : "no",
        ]);
      }
const freezeRows: (string | number)[][] = [];
const freezeJson: unknown[] = [];
for (const k of KEYS)
  for (const lossPct of [0.02, 0.05])
    for (const f of [1, 3, 7]) {
      const dem = SCEN[k]!.profile.length;
      const r = run(k, {
        tvl: 5_000_000,
        flPct: 0.03,
        loss: { pct: lossPct, atDay: dem / 2, freezeDays: f },
        raiseAfterH: 24,
      });
      freezeJson.push({ scenario: k, lossPct, freezeDays: f, ...r });
      freezeRows.push([SCEN[k]!.name, pct(lossPct), `${f} d`, d2(r.maxWaitDays), ok(r.pass)]);
    }
// longest freeze that still keeps the 7-day promise, 5M, 5% loss, first-loss 3%, 24 h case
const freezeMax: Record<string, number> = {};
for (const k of KEYS) {
  const dem = SCEN[k]!.profile.length;
  let best = 0;
  for (let f = 0.25; f <= 7; f += 0.25) {
    const r = run(k, {
      tvl: 5_000_000,
      flPct: 0.03,
      loss: { pct: 0.05, atDay: dem / 2, freezeDays: f },
      raiseAfterH: 24,
    });
    if (r.pass) best = f;
  }
  freezeMax[k] = best;
}
json.longestFreezeKeepingSevenDays = freezeMax;
json.lossEvents = lossJson;
json.freezeSensitivity = freezeJson;

// ===================================================================================
// 3. minimum parameters (TVL 5M and 2.5M)
// ===================================================================================
interface MinRow {
  tvl: number;
  mode: string;
  floor: number;
  minDaily: number | null;
  minMonthly: number | null;
  jointDaily: number | null;
  jointMonthly: number | null;
  marginDaily: number | null;
  marginMonthly: number | null;
  minBufPctLimitsOpen: number | null;
  minBufPctAtJoint: number | null;
  instantMax: { v: number; pass: boolean; worst: number }[];
  maxRequestPayable: number | null;
}
const minRows: MinRow[] = [];
for (const tvl of [5_000_000, 2_500_000]) {
  const floor = limitFloor(tvl * TSRA) / TSRA;
  for (const mode of ["static", "raise24"] as const) {
    const raise = mode === "static" ? null : 24;
    const common: Partial<Params> = { tvl, raiseAfterH: raise, fundCadenceH: 24 };
    const open = tvl; // limits >= supply: effectively off
    // monthly off, search daily
    const minD = minPassing(floor, tvl, (x) =>
      allPassAligned({ ...common, dailyLimit: x, monthlyLimit: open }),
    );
    // daily off, search monthly
    const minM = minPassing(floor, tvl, (x) =>
      allPassAligned({ ...common, dailyLimit: open, monthlyLimit: x }),
    );
    // joint: both at their minimum; raise both together until it passes
    let jd = minD === null ? null : round3(minD);
    let jm = minM === null ? null : round3(minM);
    if (jd !== null && jm !== null) {
      jm = Math.max(jm, jd);
      let guard = 0;
      while (!allPassAligned({ ...common, dailyLimit: jd, monthlyLimit: jm }) && guard++ < 60) {
        jd = round3(jd * 1.05);
        jm = round3(Math.max(jm * 1.05, jd));
      }
    }
    const minBufOpen = minPassing(0.01, 0.6, (x) =>
      allPassAligned({ ...common, bufPct: x, dailyLimit: open, monthlyLimit: open }),
    );
    // The joint minimum sits on a knife edge (1% resolution), so the buffer and instant_max
    // scans use it with a 25% margin; the margin values are the ones to put in a spec.
    const md_ = jd === null ? null : round3(jd * 1.25);
    const mm_ = jm === null ? null : round3(jm * 1.25);
    const minBufJoint =
      md_ === null || mm_ === null
        ? null
        : minPassing(0.01, 0.6, (x) =>
            allPassAligned({ ...common, bufPct: x, dailyLimit: md_, monthlyLimit: mm_ }),
          );
    const instantScan = [1_000, 5_000, 10_000, 25_000, 50_000].map((v) => {
      const over = { ...common, instantMax: v, dailyLimit: md_ ?? tvl, monthlyLimit: mm_ ?? tvl };
      return { v, pass: allPassAligned(over), worst: worstAligned(over) };
    });
    // largest single Request the joint limits can ever pay: per-shard daily cap
    const maxReq = jd === null ? null : jd / 4;
    minRows.push({
      tvl,
      mode,
      floor,
      minDaily: minD,
      minMonthly: minM,
      jointDaily: jd,
      jointMonthly: jm,
      marginDaily: md_,
      marginMonthly: mm_,
      minBufPctLimitsOpen: minBufOpen,
      minBufPctAtJoint: minBufJoint,
      instantMax: instantScan,
      maxRequestPayable: maxReq,
    });
  }
}
json.minimumParameters = minRows;

// ===================================================================================
// 4. threshold TVL, RWA and buffer sweeps
// ===================================================================================
const tvlGrid = [
  250_000, 500_000, 1_000_000, 2_000_000, 2_500_000, 3_000_000, 4_000_000, 5_000_000, 7_500_000,
  10_000_000,
];
const passRange = (res: { tvl: number; pass: boolean }[]) => {
  const ps = res.filter((r) => r.pass).map((r) => r.tvl);
  if (!ps.length) return "none";
  const lo = Math.min(...ps);
  const hi = Math.max(...ps);
  const holes = res.filter((r) => !r.pass && r.tvl > lo && r.tvl < hi).length;
  return `${M(lo)} to ${M(hi)}${holes ? " (with gaps)" : ""}`;
};
const thrRows: (string | number)[][] = [];
const thrJson: unknown[] = [];
for (const c of CASES) {
  const res = tvlGrid.map((tvl) => ({
    tvl,
    w: worst({ ...c.over, tvl }),
    pass: allPass({ ...c.over, tvl }),
  }));
  thrJson.push({ case: c.id, points: res });
  thrRows.push([c.label, ...res.map((r) => (r.pass ? d2(r.w) : `**${d2(r.w)}**`)), passRange(res)]);
}
{
  const scaled = (tvl: number): Partial<Params> => ({
    medianRequest: 0.0004 * tvl,
    maxRequest: 0.01 * tvl,
  });
  const res = tvlGrid.map((tvl) => ({
    tvl,
    w: worst({ ...CASES[2]!.over, tvl, ...scaled(tvl) }),
    pass: allPass({ ...CASES[2]!.over, tvl, ...scaled(tvl) }),
  }));
  thrJson.push({ case: "h24-scaled-sizes", points: res });
  thrRows.push([
    "24 h, request sizes scaled to TVL (median 0.04%, largest 1% of TVL)",
    ...res.map((r) => (r.pass ? d2(r.w) : `**${d2(r.w)}**`)),
    passRange(res),
  ]);
}
json.tvlSweep = thrJson;
const rwaRows: (string | number)[][] = [];
const rwaJson: unknown[] = [];
const failing = (over: Partial<Params>) => KEYS.filter((k) => !run(k, over).pass).join("") || "-";
for (const rwa of [0, 0.1, 0.2, 0.3, 0.4]) {
  const res = tvlGrid.map((tvl) => ({
    tvl,
    w: worst({ ...CASES[2]!.over, tvl, rwaPct: rwa }),
    pass: allPass({ ...CASES[2]!.over, tvl, rwaPct: rwa }),
  }));
  rwaJson.push({
    rwaPct: rwa,
    points: res,
    failingAt5M: failing({ ...CASES[2]!.over, tvl: 5_000_000, rwaPct: rwa }),
  });
  rwaRows.push([
    pct(rwa),
    pct(0.9 - rwa),
    ...res.map((r) => (r.pass ? d2(r.w) : `**${d2(r.w)}**`)),
    passRange(res),
    failing({ ...CASES[2]!.over, tvl: 5_000_000, rwaPct: rwa }),
  ]);
}
json.rwaSweep = rwaJson;
const bufRows: (string | number)[][] = [];
const bufJson: unknown[] = [];
for (const buf of [0.02, 0.05, 0.1, 0.15, 0.2, 0.3, 0.4]) {
  const res = [2_500_000, 5_000_000].map((tvl) => ({
    tvl,
    w: worst({ ...CASES[2]!.over, tvl, bufPct: buf }),
    pass: allPass({ ...CASES[2]!.over, tvl, bufPct: buf }),
  }));
  bufJson.push({ bufPct: buf, points: res });
  bufRows.push([pct(buf), ...res.map((r) => `${d2(r.w)} (${ok(r.pass)})`)]);
}
json.bufferSweep = bufJson;

// ===================================================================================
// 5. sensitivities at 5M, 24 h case
// ===================================================================================
const SENS: { id: string; label: string; over: Partial<Params> }[] = [
  { id: "base", label: "base case", over: {} },
  { id: "keeper-smallest", label: "keeper pays smallest first", over: { keeperOrder: "smallest" } },
  { id: "keeper-6h", label: "keeper acts every 6 h", over: { keeperH: 6 } },
  { id: "keeper-24h", label: "keeper acts every 24 h", over: { keeperH: 24 } },
  { id: "cadence-12h", label: "committee Funds every 12 h", over: { fundCadenceH: 12 } },
  { id: "cadence-48h", label: "committee Funds every 48 h", over: { fundCadenceH: 48 } },
  { id: "fiat-24h", label: "+24 h fiat leg before Fund", over: { fiatLegH: 24 } },
  { id: "raise-12h", label: "limits raised after 12 h", over: { raiseAfterH: 12 } },
  { id: "raise-48h", label: "limits raised after 48 h", over: { raiseAfterH: 48 } },
  { id: "tiny", label: "tiny requests (all 100 TSRA)", over: { sizeMode: "tiny" } },
  { id: "median-500", label: "median request 500 TSRA", over: { medianRequest: 500 } },
  { id: "median-10k", label: "median request 10,000 TSRA", over: { medianRequest: 10_000 } },
  { id: "blocks-10", label: "keeper wins 10% of blocks", over: { blockShare: 0.1 } },
  {
    id: "mmf-gated",
    label: "MMF gated from day 3 for 5 days",
    over: { mmfGate: { startDay: 3, days: 5 } },
  },
  { id: "mmf-lag-7", label: "MMF lag up to 7 days", over: { mmfLagMaxDays: 7 } },
  { id: "mmf-lag-3", label: "MMF lag 3 to 5 days", over: { mmfLagMinDays: 3 } },
  { id: "mmf-lag-4", label: "MMF lag 4 to 7 days", over: { mmfLagMinDays: 4, mmfLagMaxDays: 7 } },
  { id: "rwa-30", label: "mix 10/60/30 (RWA later)", over: { rwaPct: 0.3 } },
  { id: "rwa-40", label: "mix 10/50/40", over: { rwaPct: 0.4 } },
  { id: "buf-5", label: "buffer 5%", over: { bufPct: 0.05 } },
  { id: "delay-0", label: "settle_delay 0", over: { settleDelayDays: 0 } },
  { id: "delay-5", label: "settle_delay 5 days", over: { settleDelayDays: 5 } },
  { id: "suspend-24h", label: "committee suspends 72 h from hour 24", over: { suspendFromH: 24 } },
  { id: "instant-1k", label: "instant_max 1,000", over: { instantMax: 1_000 } },
  { id: "instant-50k", label: "instant_max 50,000", over: { instantMax: 50_000 } },
  { id: "shards-8", label: "8 shards", over: { shards: 8 } },
  { id: "shards-1", label: "1 shard", over: { shards: 1 } },
  { id: "whales-250k", label: "largest request 250,000 TSRA", over: { maxRequest: 250_000 } },
];
const sensRows: (string | number)[][] = [];
const sensJson: {
  id: string;
  worst: number;
  pass: boolean;
  perScenario: Record<string, number>;
}[] = [];
for (const s of SENS) {
  const per: Record<string, number> = {};
  let allOk = true;
  for (const k of KEYS) {
    const r = run(k, { tvl: 5_000_000, ...CASES[2]!.over, ...s.over });
    per[k] = r.maxWaitDays;
    if (!r.pass) allOk = false;
  }
  const w = Math.max(...Object.values(per));
  sensJson.push({ id: s.id, worst: w, pass: allOk, perScenario: per });
  sensRows.push([s.label, ...KEYS.map((k) => d2(per[k]!)), ok(allOk)]);
}
json.sensitivities = sensJson;
// month-block alignment sweep
const alignRows: (string | number)[][] = [];
const alignJson: unknown[] = [];
for (const sd of [0, 5, 10, 15, 20, 25, 29]) {
  const per = Object.fromEntries(
    KEYS.map((k) => [k, run(k, { tvl: 5_000_000, ...CASES[2]!.over, startDay: sd }).maxWaitDays]),
  );
  const st5 = minRows.find((r) => r.tvl === 5_000_000 && r.mode === "static")!;
  const stat = Object.fromEntries(
    KEYS.map((k) => [
      k,
      run(k, {
        tvl: 5_000_000,
        raiseAfterH: null,
        dailyLimit: st5.jointDaily ?? 0,
        monthlyLimit: st5.jointMonthly ?? 0,
        startDay: sd,
      }).maxWaitDays,
    ]),
  );
  const dep = Object.fromEntries(
    KEYS.map((k) => {
      const r = run(k, { tvl: 5_000_000, raiseAfterH: null, startDay: sd });
      return [k, (100 * r.paid) / r.demand];
    }),
  );
  alignJson.push({ startDay: sd, raise24: per, staticJoint: stat, deployedPaidPct: dep });
  alignRows.push([
    sd,
    ...KEYS.map((k) => d2(per[k]!)),
    ...KEYS.map((k) => d2(stat[k]!)),
    ...KEYS.map((k) => `${(dep[k]! as number).toFixed(0)}%`),
  ]);
}
json.alignment = alignJson;
// staker end-to-end (information only)
const e2eRows: (string | number)[][] = [];
const e2eJson: unknown[] = [];
for (const k of KEYS) {
  const r = run(k, {
    tvl: 5_000_000,
    ...CASES[2]!.over,
    composition: { direct: 0.7, short: 0.2, long: 0.1 },
  });
  e2eJson.push({ scenario: k, ...r });
  e2eRows.push([
    SCEN[k]!.name,
    d2(r.maxWaitDays),
    r.e2eMaxDays === null ? "-" : d2(r.e2eMaxDays),
    ok(r.pass),
  ]);
}
json.stakerEndToEnd = e2eJson;

// most sensitive assumption: largest change in worst-case wait against the base
const baseW = sensJson.find((s) => s.id === "base")!.worst;
const ranked = sensJson
  .filter((s) => s.id !== "base")
  .map((s) => ({ ...s, delta: s.worst - baseW }))
  .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
json.mostSensitive = ranked.slice(0, 5).map((r) => ({ id: r.id, worst: r.worst, delta: r.delta }));

// ===================================================================================
// report
// ===================================================================================
const mr = (tvl: number, mode: string) => minRows.find((r) => r.tvl === tvl && r.mode === mode)!;
const fmt = (x: number | null) => (x === null ? "not reachable" : n0(x));
const instantRange = (r: MinRow) => {
  const okv = r.instantMax.filter((x) => x.pass).map((x) => x.v);
  return okv.length === r.instantMax.length
    ? `all of ${n0(r.instantMax[0]!.v)}-${n0(r.instantMax.at(-1)!.v)}`
    : okv.length
      ? okv.map(n0).join(", ")
      : "none tested";
};
const fmtPct = (x: number | null) => (x === null ? "not reachable" : `${(x * 100).toFixed(1)}%`);
const dep5 = KEYS.map((k) => run(k, { ...CASES[0]!.over, tvl: 5_000_000 }));

md.push(`# Tessera 2.8 stress test: redemption runs against the real queue rules

Generated by \`scripts/tessera/stress/run.ts\` (seed ${defaults().seed}, no clock, no network). Results: \`docs/tessera-stress-2-8.results.json\`.
Rules replayed: SPEC.md §3 and §4 (queue_state.ak, queue_flow.ak limits, §4.13 batch caps). **No contract, blueprint or pin changed.**

## 1. Answer

* **5,000,000 TSRA launch cap, 24 h committee case: ${gatePass ? "PASS" : "FAIL"}.** Deployed queue parameters (daily 50,000 / monthly 500,000 / instant_max 10,000 / 4 shards), launch mix 10% buffer / 90% MMF-T-bill / 0% RWA, first-loss 0, committee Funds every 24 h and raises the limits 24 h after the first limit-bound refusal. Longest queue age: ${KEYS.map((k, i) => `${k}: ${d2(gate5[i]!.maxWaitDays)} d`).join(", ")}.
* **The limits as deployed, with no committee action, ${dep5.every((r) => r.pass) ? "pass" : "FAIL"} at 5M:** ${KEYS.map((k, i) => `${k}: ${d2(dep5[i]!.maxWaitDays)} d${dep5[i]!.unpaid > 0 ? ` (${n0(dep5[i]!.unpaid)} TSRA unpaid at day ${defaults().tailDays + SCEN[k]!.profile.length})` : ""}`).join(", ")}. The daily limit, not the cash, is what binds.
* **Parameters for the parameter spec** (every Request in scenarios a-d paid within 7 days of creation, 24 h committee Fund cadence, judged over seven alignments of the run within the 30-day limit block). Plainly:
  * **Limits that need no committee action** (committee never touches the limits): at 5M, \`dailyLimit\` at least ${fmt(mr(5_000_000, "static").jointDaily)} (${pct((mr(5_000_000, "static").jointDaily ?? 0) / 5_000_000)} of TVL) and \`monthlyLimit\` at least ${fmt(mr(5_000_000, "static").jointMonthly)} (${pct((mr(5_000_000, "static").jointMonthly ?? 0) / 5_000_000)} of TVL, so in practice no monthly cap); with a 25% margin ${fmt(mr(5_000_000, "static").marginDaily)} and ${fmt(mr(5_000_000, "static").marginMonthly)}. At 2.5M: ${fmt(mr(2_500_000, "static").jointDaily)} and ${fmt(mr(2_500_000, "static").jointMonthly)}; with margin ${fmt(mr(2_500_000, "static").marginDaily)} and ${fmt(mr(2_500_000, "static").marginMonthly)}. Daily as a share of TVL: ${pct((mr(5_000_000, "static").jointDaily ?? 0) / 5_000_000)} at 5M, ${pct((mr(2_500_000, "static").jointDaily ?? 0) / 2_500_000)} at 2.5M.
  * **If the committee raises the limits within 24 h of the first refusal:** the floor is enough (${fmt(mr(5_000_000, "raise24").floor)} a day at 5M, ${fmt(mr(2_500_000, "raise24").floor)} at 2.5M): the deployed 50,000 / 500,000 passes at 5M. That makes the 7-day promise depend on a 3-of-5 action inside a day.
  * **Largest Request payable** is \`dailyLimit / shards\`: ${fmt(mr(5_000_000, "static").maxRequestPayable)} TSRA at the static 5M value; 12,500 at the deployed limits.
  * **Buffer %:** no minimum above ${fmtPct(mr(5_000_000, "static").minBufPctLimitsOpen)} (the bottom of the search) was found for the 7-day test, at either TVL, because nothing is payable for 2-3 days and the committee refills inside that window. The buffer sets the instant tier, not the 7-day promise. A buffer of ${fmtPct(0.05)} to ${fmtPct(0.1)} passes everywhere tested.
  * **\`instant_max\`:** ${instantRange(mr(5_000_000, "static"))} passes at 5M with static limits; failing: ${
    mr(5_000_000, "static")
      .instantMax.filter((x) => !x.pass)
      .map((x) => `${n0(x.v)} (${d2(x.worst)} d)`)
      .join(", ") || "none"
  }. Results near the edge are not monotone (table in 3.3), so keep the deployed 10,000.

${table(
  [
    "TVL",
    "committee",
    "min dailyLimit",
    "min monthlyLimit",
    "both together",
    "with 25% margin (daily / monthly)",
    "min buffer % (limits open)",
    "min buffer % (at margin limits)",
    "instant_max range that passes",
  ],
  [5_000_000, 2_500_000].flatMap((tvl) =>
    (["static", "raise24"] as const).map((m) => {
      const r = mr(tvl, m);
      return [
        M(tvl),
        m === "static" ? "never raises limits" : "raises after 24 h",
        fmt(r.minDaily),
        fmt(r.minMonthly),
        `${fmt(r.jointDaily)} / ${fmt(r.jointMonthly)}`,
        `${fmt(r.marginDaily)} / ${fmt(r.marginMonthly)}`,
        fmtPct(r.minBufPctLimitsOpen),
        fmtPct(r.minBufPctAtJoint),
        instantRange(r),
      ];
    }),
  ),
)}

Amounts in whole TSRA. "Static" is the set of launch limits that need **no** committee action on the limits at all (the committee still Funds every 24 h); it is the number to put in the parameter spec. The limit floor at 5M is ${n0(mr(5_000_000, "static").floor)} a day (1% of supply) and at 2.5M ${n0(mr(2_500_000, "static").floor)}.

## 2. What is modelled

**Rules taken from the contracts (not from memory).** Request bucket = day of creation; \`payable_after = (bucket + 1) day + settle_delay\` (2 d, hard max 7 d); a Request is paid whole, from one shard, by anyone, in any order outside short mode; each shard enforces \`daily_limit / shards\` and \`monthly_limit / shards\` with 30-day month blocks (\`shard_after\`); \`Instant\` up to \`instant_max\` per transaction against a shard's balance and caps; the limit floor \`max(10,000, supply/100)\`; short mode (entered when a Request of at most \`probe_max\` that is 24 h overdue cannot be paid by any shard; 24 h registration window with no payment; then \`PayShort\` strictly oldest day first; exit when the tallies are empty; 24 h before re-entry; \`Instant\` and \`Settle\` refused while active); the loss freeze (\`Instant\` and \`Settle\` refused while \`loss_pending_until > lo\`; \`Request\` and \`Cancel\` stay open); the §4.13 batch caps (Settle 20, PayShort 16, Register 12) with one transaction per shard (or per ShortState) per block of 20 s, of which the keeper is assumed to win ${pct(defaults().blockShare)}.

**Reserve side (proposed parameters, approved at the checkpoint).**

${table(
  ["sleeve", "base (launch)", "RWA-later case", "behaviour"],
  [
    [
      "on-chain buffer (shards)",
      "10%",
      "10%",
      "cash at T+0; refilled only by committee Fund, 24 h cadence, 3-of-5",
    ],
    [
      "MMF / T-bill",
      "90%",
      "60%",
      `redemption lag ${defaults().mmfLagMinDays} d up to ${pct(defaults().mmfLowRate)} of the sleeve a day, rising linearly to ${defaults().mmfLagMaxDays} d at ${pct(defaults().mmfHighRate)} a day or more; gated variant: orders placed during a 5-day gate pay out no earlier than its end`,
    ],
    ["credit / RWA", "0%", "30% (swept 0-40%)", "zero liquidity for the whole run"],
    [
      "first-loss",
      "0 (fills from yield)",
      "3% of TSRA liabilities (target)",
      "held on top of TVL; backed by MMF; absorbs a loss before stakers",
    ],
  ],
)}

**Committee behaviour (an assumption, not a contract rule).** Reactive and needs-based: at each 24 h tick it orders from the MMF sleeve enough to cover every queued Request plus the buffer target (buffer % of the current supply), the cash reaches the wallet after the lag, and the next tick Funds shards (first one shard large enough for the biggest unpaid Request, then the emptiest first). It does not pre-position for a forecast run. It raises the limits (to the supply, which removes the cap; the rule only needs monthly >= daily) a fixed time after the first hour in which a Request, queued or instant, is refused because no shard has cap room. \`Defund\` is never used. Suspension is off except in one variant.

**Demand.** Hourly steps. Run percentages are shares of the initial TVL, asked for evenly through each day (scenario (d) is 3% of the initial TVL a day, 90% in all). Request sizes: seeded log-normal, median 2,000 TSRA, sigma 1.2, clamped to 100-50,000 TSRA; the same stream for every run so variants differ only in the parameter changed. Every arrival tries \`Instant\` first if it is at most \`instant_max\`. The run continues ${defaults().tailDays} days past the last demand day; a Request still unpaid then counts with its age at that time and fails the test.

**The 7-day test.** Queue age = creation of the Request to payment (instant = 0). Pass = every Request paid and the longest age at most 7 days.

## 3. Results

### 3.1 Scenarios (a)-(d), no loss, base mix, four committee cases

${gridMd.join("\n\n")}

### 3.2 Threshold TVL

Longest queue age in days over scenarios (a)-(d), base mix; **bold** = fails the 7-day test. Last column: the lowest and highest TVL on the grid that pass. Request sizes are absolute (the same holders at every TVL) except in the last row, so at a small TVL the 50,000 TSRA largest request is a large share of the pool.

${table(["committee case", ...tvlGrid.map(M), "passing range"], thrRows)}

Sleeve mix, 24 h case, buffer fixed at 10%, MMF the remainder:

${table(["RWA", "MMF", ...tvlGrid.map(M), "passing range", "scenarios failing at 5M"], rwaRows)}

Buffer share, 24 h case, longest age in days (scenarios a-d):

${table(["buffer", "2.5M", "5M"], bufRows)}

### 3.3 Minimum parameters in detail

${table(
  [
    "TVL",
    "committee",
    "floor",
    "min daily",
    "min monthly",
    "joint daily",
    "joint monthly",
    "margin daily",
    "margin monthly",
    "largest payable Request (joint daily / shards)",
  ],
  minRows.map((r) => [
    M(r.tvl),
    r.mode,
    n0(r.floor),
    fmt(r.minDaily),
    fmt(r.minMonthly),
    fmt(r.jointDaily),
    fmt(r.jointMonthly),
    fmt(r.marginDaily),
    fmt(r.marginMonthly),
    fmt(r.maxRequestPayable),
  ]),
)}

\`instant_max\` (limits at the 25% margin values, every scenario a-d, longest age in days):

${table(
  ["TVL", "committee", ...[1_000, 5_000, 10_000, 25_000, 50_000].map(n0)],
  minRows.map((r) => [
    M(r.tvl),
    r.mode,
    ...r.instantMax.map((x) => `${d2(x.worst)} (${ok(x.pass)})`),
  ]),
)}

### 3.4 Loss events, scenario (e): worst wait, **not** part of the 7-day gate

A 2% or 5% loss of TVL at the middle of the run, a 3-day \`OpenLoss\` freeze, committee 24 h case. The freeze refuses \`Instant\` and \`Settle\`, so requests that become payable during it wait for it by construction. The waterfall is first-loss, then stakers by assets (none in this all-TSRA case), then the remainder is a par shortfall that falls on whoever is paid last.

${table(["scenario", "TVL", "loss", "first-loss", "worst wait (d)", "unpaid at end (TSRA)", "sleeve exhausted"], lossRows)}

Freeze length sensitivity (5M, first-loss 3%, 24 h case). What freeze cap the 7-day promise needs:

${table(["scenario", "loss", "freeze", "worst wait (d)", "7-day"], freezeRows)}

Longest freeze that still keeps every Request inside 7 days (5M, 5% loss, first-loss 3%, 24 h case, 0.25-day steps): ${KEYS.map((k) => `${k}: ${freezeMax[k]} d`).join(", ")}. The contracts allow 7 days (\`max_loss_pending_ms\`), and a 7-day freeze fails all four scenarios; a promise of 7-day redemption needs a freeze cap of about **${Math.min(...Object.values(freezeMax))} days** at these parameters.

### 3.5 Sensitivities (5M, 24 h case, longest queue age in days)

${table(["change", "(a)", "(b)", "(c)", "(d)", "7-day"], sensRows)}

Start of the run within the 30-day limit block (day 0 = block starts). Raise-24 h columns then as-deployed columns:

${table(["start day", "a", "b", "c", "d", "a (static)", "b (static)", "c (static)", "d (static)", "a paid", "b paid", "c paid", "d paid"], alignRows)}

### 3.6 Stakers, end to end (information only, not a gate)

Holder mix 70% TSRA / 20% short-tier sTSRA / 10% long-tier (cannot exit inside the run). Short-tier holders \`RequestUnstake\` and reach the queue one 7-day cooldown later. A 2-3 day settle delay on top of a 7-day cooldown puts their end-to-end time past 7 days by construction.

${table(["scenario", "queue age, max (d)", "staker end-to-end, max (d)", "queue 7-day"], e2eRows)}

## 4. What the model shows`);

const PARAMS_NOT_ASSUMPTIONS = new Set([
  "rwa-30",
  "rwa-40",
  "delay-0",
  "delay-5",
  "buf-5",
  "instant-1k",
  "instant-50k",
  "shards-8",
  "shards-1",
]);
const top = ranked.filter((r) => !PARAMS_NOT_ASSUMPTIONS.has(r.id)).slice(0, 4);
const depFail = CASES[0] && KEYS.filter((k, i) => !dep5[i]!.pass);
md.push(`
* **The limits are the binding constraint, not the cash.** At 5M the deployed daily limit (50,000, 1% of supply and also the floor) and monthly limit (500,000, 10%) cannot pay ${depFail.map((k) => SCEN[k]!.name).join("; ") || "any scenario"} within 7 days; a committee that raises them within 24 h of the first refusal does. An increase takes effect at once (§4.7), so this is a 3-of-5 action that must be reachable inside a day.
* **A single shard pays a Request whole and each shard's daily cap is \`daily_limit / shards\`.** At the deployed limits the largest Request that can ever be paid is 12,500 TSRA; a larger one waits for a raise. A holder moving 20,000 TSRA is not served until the limits go up, whatever the buffer.
* **Where the 4-5 days come from.** Nothing is payable before \`(bucket + 1) day + 2 d\`, 2-3 days after creation. The cash arrives later than that in the heavy runs: the committee orders at its next tick (up to 24 h), the MMF pays out after at least 2 days, and the next tick Funds the shards (up to 24 h more). A Request that goes 24 h overdue without a shard able to pay it enters short mode, which adds a day with no payments (the registration window). In the traced worst case of scenario (a) at 5M a Request of ${n0(gate5[0]!.worstRequest!.qty)} TSRA created in hour ${gate5[0]!.worstRequest!.createdH} is paid in hour ${gate5[0]!.worstRequest!.paidH}.
* **Short mode** costs at least one full day with no payments (registration window), needs a Request already 24 h past \`payable_after\`, and then pays strictly oldest day first. It appears in the base case at 5M for (a) and (b), about 1-1.5 days each, and is the main reason those two sit near 4.7 days rather than 3.
* **Scenario (d) cannot be met if more than 10% of the reserve is illiquid.** It redeems 90% of the initial TVL; with the buffer at 10% and RWA above 0% the liquid sleeves are below 90%, so (d) fails at every TVL (table 3.2). That is arithmetic, not a model effect.
* **Most sensitive modelling assumptions** (change in the worst longest-age against the base case, days; structural parameters such as the RWA share or settle_delay are excluded and reported above): ${top.map((r) => `${SENS.find((s) => s.id === r.id)!.label} (${r.delta >= 0 ? "+" : ""}${d2(r.delta)})`).join("; ")}.
* **Contract observations** (reported, not changed): see section 6.

## 5. Assumptions that are mine, not the contracts'

1. Committee behaviour as described in section 2 (reactive, daily, raises limits to the supply on detection). A committee that forecasts demand, or one that acts slower than the case modelled, moves the results (see the 12 h / 24 h / 48 h cases).
2. MMF lag model and the gate; no liquidation haircut (a loss is modelled only through the (e) events).
3. Request sizes (log-normal, median 2,000, cap 50,000) and that every arrival tries \`Instant\` first. Holder concentration is a real unknown: the "largest request 250,000" row shows its effect.
4. Keeper wins ${pct(defaults().blockShare)} of blocks, acts hourly, no competing traffic; no failed or contended transactions other than the one-transaction-per-shard-per-block bound.
5. No Cancel (nobody leaves the queue), no minting during the run, \`Sweep\` is not modelled as a constraint (it only burns what is already paid; the number of Sweep transactions needed is in the JSON).
6. Reserve backing is 1:1 and the first-loss reserve sits on top of TVL; a par shortfall appears only as cash that never arrives.
7. Timing is hourly; intra-hour effects (the same-block races of §3a.4) are not modelled.

## 6. Open risks and contract observations

* **Per-shard cap vs Request size (observation, no fix here).** \`daily_limit / shards\` is a hard per-Request ceiling. With 4 shards at 50,000 the ceiling is 12,500 TSRA, 1.25 times \`instant_max\`. A parameter-spec question, not a code bug: set \`daily_limit >= shards x\` the largest Request you intend to serve.
* **The monthly limit is a 30-day block, not a rolling window** (\`day / 30\`). A run that starts at the start of a block has the whole month's allowance used up inside the block; one that straddles a boundary has two. The alignment table shows the spread.
* **A decrease needs 7 days' notice but an increase applies at once**, so the dependence on committee reaction time is one-sided: nothing in the contracts forces the committee to raise the limits in a run.
* **Short mode and the limit-bound case:** short mode is entered only when a shard cannot pay a probe Request, so a limit-bound run (cash on hand, caps exhausted) can still enter it; the registration window then adds a day with no payments. Reported, not changed.
* **\`Burn\` does not lower \`attested_reserve\` (A-1)** is unchanged and is not exercised by this model.
* Not covered: payout-asset depeg (R-5), keeper outage beyond the latency cases, simultaneous suspension and loss freeze beyond the one variant.
`);

mkdirSync(dirname(OUT_MD), { recursive: true });
writeFileSync(OUT_MD, md.join("\n") + "\n");
writeFileSync(OUT_JSON, JSON.stringify(json, null, 1) + "\n");
console.log(`wrote ${OUT_MD} and ${OUT_JSON}`);
console.log(`5M gate (24 h case): ${gatePass ? "PASS" : "FAIL"}`);
