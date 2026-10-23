/**
 * Deterministic redemption-run simulator for Tessera (Phase 2.8).
 *
 * Replays a redemption profile hour by hour against the queue rules of
 * SPEC.md §4 (see rules.ts) and a reserve split into sleeves with settlement lags.
 * Same Params -> same Result: the only randomness is a seeded PRNG for request sizes.
 *
 * What is modelled (and, as important, what is not) is written out in
 * docs/tessera-stress-2-8.md; the comments here say where each rule comes from.
 */
import {
  BLOCK_MS,
  DAY_MS,
  HOUR_MS,
  PAYSHORT_CAP,
  REGISTER_CAP,
  SETTLE_CAP,
  SHORT_OVERDUE_MS,
  SHORT_REENTRY_MS,
  SHORT_WINDOW_MS,
  TSRA,
  dayOf,
  payableAfterOf,
  shardAfter,
  shardCap,
  tallyAdd,
  tallySub,
  type ShardState,
  type Tally,
} from "./rules";

export interface Params {
  /** Total supply at the start, whole TSRA. All of it is backed 1:1. */
  tvl: number;
  /** Sleeve split of the reserve: buffer + MMF/T-bill + RWA = 1 (mmf is the remainder). */
  bufPct: number;
  rwaPct: number;
  /** First-loss reserve as a share of TSRA liabilities, held IN ADDITION to the tvl. */
  flPct: number;
  /** Queue parameters (whole TSRA for amounts). */
  dailyLimit: number;
  monthlyLimit: number;
  instantMax: number;
  minRequest: number;
  settleDelayDays: number;
  shards: number;
  /** Committee reaction: hours after the first limit-bound refusal until limits are raised; null = never. */
  raiseAfterH: number | null;
  /** The committee Funds shards / orders from sleeves at this cadence and hour-of-day offset. */
  fundCadenceH: number;
  fundOffsetH: number;
  /** Extra hours between a sleeve paying out and the cash being in the payout asset. */
  fiatLegH: number;
  /** A keeper acts every this many hours; its ordering inside a day. */
  keeperH: number;
  keeperOrder: "oldest" | "smallest";
  /** Share of blocks in which the keeper (or the short-mode UTxO) gets a transaction in. */
  blockShare: number;
  /** MMF/T-bill redemption lag in days: minLag at <= lowRate of the sleeve a day, maxLag at >= highRate. */
  mmfLagMinDays: number;
  mmfLagMaxDays: number;
  mmfLowRate: number;
  mmfHighRate: number;
  /** Gate: MMF redemptions ordered during [startDay, startDay+days) pay out no earlier than the gate's end. */
  mmfGate: { startDay: number; days: number } | null;
  /** Variant: the committee suspends Instant and Settle for 72 h from this hour of the run. */
  suspendFromH: number | null;
  /** Request sizes. */
  sizeMode: "lognormal" | "tiny";
  medianRequest: number;
  sigma: number;
  maxRequest: number;
  /** Demand: share of the initial tvl asked for on each day of the run. */
  profile: number[];
  /** First day index of the run (alignment with the 30-day limit block: 0 = a block starts). */
  startDay: number;
  /** One loss event: pct of tvl, at this day offset into the run, with a freeze of this many days. */
  loss: { pct: number; atDay: number; freezeDays: number } | null;
  /** Holder mix: staker shares exit via a 7-day Ticket cooldown (short) or not at all (long). */
  composition: { direct: number; short: number; long: number } | null;
  seed: number;
  /** Days simulated after the last demand day. */
  tailDays: number;
}

export function defaults(): Params {
  return {
    tvl: 5_000_000,
    bufPct: 0.1,
    rwaPct: 0,
    flPct: 0,
    dailyLimit: 50_000,
    monthlyLimit: 500_000,
    instantMax: 10_000,
    minRequest: 100,
    settleDelayDays: 2,
    shards: 4,
    raiseAfterH: 24,
    fundCadenceH: 24,
    fundOffsetH: 12,
    fiatLegH: 0,
    keeperH: 1,
    keeperOrder: "oldest",
    blockShare: 0.5,
    mmfLagMinDays: 2,
    mmfLagMaxDays: 5,
    mmfLowRate: 0.1,
    mmfHighRate: 0.3,
    mmfGate: null,
    suspendFromH: null,
    sizeMode: "lognormal",
    medianRequest: 2_000,
    sigma: 1.2,
    maxRequest: 50_000,
    profile: [],
    startDay: 0,
    loss: null,
    composition: null,
    seed: 28,
    tailDays: 21,
  };
}

export interface Result {
  requests: number;
  demand: number;
  paid: number;
  paidInstant: number;
  unpaid: number;
  /** Longest wait (creation to payment; unpaid requests count their age at the end of the run), days. */
  maxWaitDays: number;
  /** Largest total of unpaid queued Requests at any hour, whole TSRA. */
  peakQueue: number;
  shortDays: number;
  shortEntries: number;
  /** Hours from the start at which limits were raised; null if never. */
  raisedAtH: number | null;
  limitBoundAtH: number | null;
  /** Largest unpaid request that no shard cap can ever fit (qty > per-shard daily cap). */
  unpayableAtLimits: number;
  /** Cash that never arrived: unpaid TSRA at the end while sleeves had nothing left to sell. */
  sleeveExhausted: boolean;
  /** Staker end-to-end (cooldown + queue) in days, when a composition is given. */
  e2eMaxDays: number | null;
  /** Largest batch counts used per hour (checks the block/batch bound). */
  maxSettleTxPerHour: number;
  settleTxTotal: number;
  /** Sweep transactions needed to burn what was paid (20 Sinks each). */
  sweepTx: number;
  /** Median and p95 wait of queued (non-instant) requests, days. */
  waitP50Days: number;
  waitP95Days: number;
  /** The Request with the longest wait: size (TSRA), creation and payment hour of the run (null = unpaid). */
  worstRequest: { qty: number; createdH: number; paidH: number | null } | null;
  pass: boolean;
}

// -- seeded PRNG ----------------------------------------------------------------
function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function normal(rnd: () => number): number {
  const u = Math.max(rnd(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
}

interface Req {
  id: number;
  qty: number; // micro units
  createdMs: number;
  origMs: number; // creation of the originating RequestUnstake (staker flow) or createdMs
  bucket: number;
  payableAfter: number;
  registered: boolean;
  paidMs: number | null;
  viaInstant: boolean;
}
interface Shard {
  balance: number;
  st: ShardState;
}

const lerp = (x: number, x0: number, x1: number, y0: number, y1: number) =>
  y0 + ((Math.min(Math.max(x, x0), x1) - x0) / (x1 - x0)) * (y1 - y0);

export function simulate(p: Params): Result {
  const rnd = mulberry32(p.seed);
  const t0 = p.startDay * DAY_MS;
  const K = p.shards;
  const supply0 = p.tvl * TSRA;
  const demandDays = p.profile.length;
  const totalH = (demandDays + p.tailDays) * 24;

  // -- reserve ---------------------------------------------------------------------
  const flAmt = Math.round(p.flPct * supply0);
  let mmf = Math.round((1 - p.bufPct - p.rwaPct) * supply0) + flAmt; // first-loss backing sits in MMF
  let rwa = Math.round(p.rwaPct * supply0);
  const mmf0 = Math.max(mmf, 1);
  const shards: Shard[] = [];
  const buf0 = Math.round(p.bufPct * supply0);
  for (let i = 0; i < K; i++)
    shards.push({
      balance: Math.floor(buf0 / K),
      st: { day: dayOf(t0), paidDay: 0, month: Math.floor(dayOf(t0) / 30), paidMonth: 0 },
    });
  let wallet = 0;
  const inTransit: { arrivesMs: number; amount: number }[] = [];
  const mmfOrders: { ms: number; amount: number }[] = [];

  let daily = p.dailyLimit * TSRA;
  let monthly = p.monthlyLimit * TSRA;
  const settleDelay = p.settleDelayDays * DAY_MS;

  // -- state -----------------------------------------------------------------------
  const all: Req[] = [];
  let queue: Req[] = []; // unpaid Requests (not instant), creation order
  let nextId = 0;
  let paid = 0;
  let paidInstant = 0;
  let demand = 0;
  let peakQueue = 0;
  let settleTxTotal = 0;
  let maxSettleTxPerHour = 0;
  let sweepSinks = 0;
  let blockedUntil = 0; // Instant and Settle refused while blockedUntil > now (suspension, loss freeze)
  let limitBoundAtH: number | null = null;
  let raisedAtH: number | null = null;
  let short = {
    active: false,
    regDeadline: 0,
    lastExit: -Infinity,
    tallies: [] as Tally[],
  };
  let shortHours = 0;
  let shortEntries = 0;
  let sleeveExhausted = false;
  let lossApplied = false;
  let stakerLoss = 0; // fraction taken from staker Tickets by a loss
  const pendingStaker: { atMs: number; qty: number; origMs: number }[] = [];
  const sizeBuf: { pending: number | null } = { pending: null };
  let acc = 0;

  const drawSize = (): number => {
    if (p.sizeMode === "tiny") return p.minRequest * TSRA;
    const z = normal(rnd);
    const v = Math.exp(Math.log(p.medianRequest) + p.sigma * z);
    return Math.round(Math.min(Math.max(v, p.minRequest), p.maxRequest) * TSRA);
  };

  const shardCaps = () => [shardCap(daily, K), shardCap(monthly, K)] as const;
  const tryPay = (sh: Shard, day: number, qty: number): boolean => {
    if (sh.balance < qty) return false;
    const [dc, mc] = shardCaps();
    const next = shardAfter(sh.st, day, qty, dc, mc);
    if (!next) return false;
    sh.st = next;
    sh.balance -= qty;
    return true;
  };
  /** No shard has cap room for `qty` (daily or monthly), whatever its balance: the limits are what binds. */
  const capsRefuseEverywhere = (qty: number, day: number): boolean => {
    const [dc, mc] = shardCaps();
    return shards.every((s) => !shardAfter(s.st, day, qty, dc, mc));
  };
  const noteLimitBound = (h: number) => {
    if (limitBoundAtH === null) limitBoundAtH = h;
  };

  const emit = (qty: number, ms: number, h: number, origMs: number, instantOk: boolean) => {
    const bucket = dayOf(ms);
    const r: Req = {
      id: nextId++,
      qty,
      createdMs: ms,
      origMs,
      bucket,
      payableAfter: payableAfterOf(bucket, settleDelay),
      registered: false,
      paidMs: null,
      viaInstant: false,
    };
    all.push(r);
    demand += qty;
    const blocked = blockedUntil > ms;
    if (instantOk && !blocked && !short.active && qty <= p.instantMax * TSRA) {
      // The shard with the most payable room takes it (first fit by balance).
      const order = [...shards].sort((a, b) => b.balance - a.balance);
      for (const sh of order) {
        if (tryPay(sh, dayOf(ms), qty)) {
          r.paidMs = ms;
          r.viaInstant = true;
          paid += qty;
          paidInstant += qty;
          sweepSinks += 1;
          return;
        }
      }
      if (capsRefuseEverywhere(qty, dayOf(ms))) noteLimitBound(h);
    }
    queue.push(r);
  };

  // -- the clock -------------------------------------------------------------------
  const lossAtH = p.loss ? Math.round(p.loss.atDay * 24) : -1;
  for (let h = 0; h < totalH; h++) {
    const now = t0 + h * HOUR_MS;
    const day = dayOf(now);

    // 1. loss event (OpenLoss freeze, then the waterfall)
    if (p.loss && !lossApplied && h === lossAtH) {
      lossApplied = true;
      const lambda = Math.round(p.loss.pct * supply0);
      const d = Math.min(lambda, flAmt); // first-loss reserve first
      const rem = lambda - d;
      // stakers and Tickets by assets
      const stakerPool = p.composition ? (p.composition.short + p.composition.long) * supply0 : 0;
      const remStk = Math.min(rem, stakerPool);
      if (stakerPool > 0) stakerLoss = remStk / stakerPool;
      // the reserve loses the whole `lambda`, taken pro rata from the MMF and RWA sleeves
      const base = mmf + rwa;
      if (base > 0) {
        const fromMmf = Math.round((lambda * mmf) / base);
        mmf = Math.max(0, mmf - fromMmf);
        rwa = Math.max(0, rwa - (lambda - fromMmf));
      }
      blockedUntil = Math.max(blockedUntil, now + p.loss.freezeDays * DAY_MS);
    }
    if (p.suspendFromH !== null && h === p.suspendFromH)
      blockedUntil = Math.max(blockedUntil, now + 3 * DAY_MS);

    // 2. arrivals
    const dIdx = Math.floor(h / 24);
    const frac = dIdx < demandDays ? p.profile[dIdx]! : 0;
    if (frac > 0) {
      const comp = p.composition;
      const directShare = comp ? comp.direct : 1;
      acc += (frac * supply0 * directShare) / 24;
      if (comp) {
        // short-tier holders RequestUnstake now; their TSRA arrives one cooldown later
        const q = (frac * supply0 * comp.short) / 24;
        if (q > 0) pendingStaker.push({ atMs: now + 7 * DAY_MS, qty: q, origMs: now });
      }
      let guard = 0;
      while (guard++ < 5_000_000) {
        const size = sizeBuf.pending ?? drawSize();
        if (size <= acc) {
          sizeBuf.pending = null;
          acc -= size;
          emit(size, now + Math.floor(HOUR_MS / 2), h, now + Math.floor(HOUR_MS / 2), true);
        } else {
          sizeBuf.pending = size;
          break;
        }
      }
    } else if (acc >= p.minRequest * TSRA) {
      emit(Math.floor(acc), now + Math.floor(HOUR_MS / 2), h, now + Math.floor(HOUR_MS / 2), true);
      acc = 0;
    }
    // staker flows reaching the queue after cooldown (a Claim, then a Request)
    for (let i = pendingStaker.length - 1; i >= 0; i--) {
      const s = pendingStaker[i]!;
      if (s.atMs <= now) {
        pendingStaker.splice(i, 1);
        let q = s.qty * (1 - stakerLoss);
        while (q >= p.minRequest * TSRA) {
          const size = Math.min(drawSize(), Math.floor(q));
          q -= size;
          // Claim pays TSRA; the Request is created in this hour, instant allowed
          emit(size, now + Math.floor(HOUR_MS / 2), h, s.origMs, true);
        }
      }
    }

    // 3. cash from sleeves reaches the committee wallet
    for (let i = inTransit.length - 1; i >= 0; i--)
      if (inTransit[i]!.arrivesMs <= now) {
        wallet += inTransit[i]!.amount;
        inTransit.splice(i, 1);
      }

    // 4. committee: raise limits once the reaction time has passed
    if (
      p.raiseAfterH !== null &&
      raisedAtH === null &&
      limitBoundAtH !== null &&
      h >= limitBoundAtH + p.raiseAfterH
    ) {
      raisedAtH = h;
      daily = Math.max(daily, supply0 * 100);
      monthly = Math.max(monthly, supply0 * 100);
    }

    // 5. committee: order from sleeves, then Fund shards (cadence, offset)
    if (h >= 0 && (h - p.fundOffsetH + 240 * 24) % p.fundCadenceH === 0) {
      const unpaid = queue.reduce((a, r) => a + r.qty, 0);
      const supplyNow = Math.max(supply0 - paid, 0);
      const bufTarget = p.bufPct * supplyNow;
      const hold =
        shards.reduce((a, s) => a + s.balance, 0) +
        wallet +
        inTransit.reduce((a, x) => a + x.amount, 0);
      let need = unpaid + bufTarget - hold;
      // A Request is paid whole from ONE shard: also make sure cash for the largest queued
      // Request can reach a single shard (the committee cannot move cash between shards).
      if (queue.length > 0) {
        const biggest = queue.reduce((m, r) => Math.max(m, r.qty), 0);
        const topBal = Math.max(...shards.map((x) => x.balance));
        const inFlight = wallet + inTransit.reduce((a, x) => a + x.amount, 0);
        need = Math.max(need, biggest - topBal - inFlight);
      }
      if (need > 0) {
        const order = Math.min(need, mmf);
        if (order > 0) {
          const trailing = mmfOrders
            .filter((o) => o.ms > now - DAY_MS)
            .reduce((a, o) => a + o.amount, 0);
          const rate = (trailing + order) / mmf0;
          const lagDays = lerp(rate, p.mmfLowRate, p.mmfHighRate, p.mmfLagMinDays, p.mmfLagMaxDays);
          let arrives = now + Math.round(lagDays * DAY_MS) + p.fiatLegH * HOUR_MS;
          if (p.mmfGate) {
            const gStart = (p.startDay + p.mmfGate.startDay) * DAY_MS;
            const gEnd = gStart + p.mmfGate.days * DAY_MS;
            if (now >= gStart && now < gEnd)
              arrives = Math.max(arrives, gEnd + p.fiatLegH * HOUR_MS);
          }
          mmf -= order;
          mmfOrders.push({ ms: now, amount: order });
          inTransit.push({ arrivesMs: arrives, amount: order });
        } else if (mmf <= 0 && unpaid > 0) sleeveExhausted = true;
      }
      // Fund: first make sure one shard can pay the largest unpaid Request (a Request is paid from a
      // single shard, whole), then water-fill the emptiest shards so the buffer stays even.
      if (wallet > 0 && queue.length > 0) {
        const biggest = queue.reduce((m, r) => Math.max(m, r.qty), 0);
        const top = [...shards].sort((x, y) => y.balance - x.balance)[0]!;
        if (top.balance < biggest) {
          const put = Math.min(wallet, biggest - top.balance);
          top.balance += put;
          wallet -= put;
        }
      }
      if (wallet > 0) {
        const sorted = [...shards].sort((x, y) => x.balance - y.balance);
        let left = wallet;
        let i = 0;
        while (left > 0) {
          const k = i + 1;
          const cur = sorted[i]!.balance;
          const level = k < K ? sorted[k]!.balance : Infinity;
          const need = (level - cur) * k;
          if (need >= left) {
            const each = Math.floor(left / k);
            for (let j = 0; j < k; j++) sorted[j]!.balance += each;
            sorted[0]!.balance += left - each * k;
            left = 0;
          } else {
            for (let j = 0; j < k; j++) sorted[j]!.balance = level;
            left -= need;
            i++;
          }
        }
        wallet = 0;
      }
    }

    // 6. short mode: enter / exit (anyone may; evaluated every hour)
    if (short.active) shortHours++;
    if (!short.active && blockedUntil <= now && now - short.lastExit >= SHORT_REENTRY_MS) {
      const probe = queue.find(
        (r) =>
          r.payableAfter + SHORT_OVERDUE_MS <= now &&
          r.qty <= p.instantMax * TSRA &&
          shards.every((s) => {
            const [dc, mc] = shardCaps();
            return s.balance < r.qty || !shardAfter(s.st, day, r.qty, dc, mc);
          }),
      );
      if (probe) {
        short = {
          active: true,
          regDeadline: now + SHORT_WINDOW_MS,
          lastExit: short.lastExit,
          tallies: [],
        };
        shortEntries++;
        for (const r of queue) r.registered = false;
      }
    } else if (short.active && now >= short.regDeadline && short.tallies.length === 0) {
      short.active = false;
      short.lastExit = now;
    }

    // 7. keeper
    if (h % p.keeperH === 0 && blockedUntil <= now) {
      const txBudget = Math.floor((3600 / (BLOCK_MS / 1000)) * p.keeperH * p.blockShare);
      let txThisStep = 0;
      if (!short.active) {
        const cands = queue.filter((r) => r.payableAfter <= now);
        if (p.keeperOrder === "smallest") cands.sort((a, b) => a.qty - b.qty || a.id - b.id);
        for (const sh of shards) {
          let n = 0;
          for (const r of cands) {
            if (r.paidMs !== null) continue;
            if (n >= txBudget * SETTLE_CAP) break;
            if (tryPay(sh, day, r.qty)) {
              r.paidMs = now;
              paid += r.qty;
              sweepSinks += 1;
              n++;
            }
          }
          txThisStep += Math.ceil(n / SETTLE_CAP);
        }
        // limit-bound? a payable Request that no shard's caps have room for
        for (const r of cands) {
          if (r.paidMs === null && capsRefuseEverywhere(r.qty, day)) {
            noteLimitBound(h);
            break;
          }
        }
      } else {
        // register payable, unregistered Requests (oldest first), ShortState serialises: 1 tx per block
        const regBudget =
          Math.floor((3600 / (BLOCK_MS / 1000)) * p.keeperH * p.blockShare) * REGISTER_CAP;
        let regN = 0;
        for (const r of queue) {
          if (regN >= regBudget) break;
          if (r.payableAfter <= now && !r.registered) {
            r.registered = true;
            short.tallies = tallyAdd(short.tallies, r.bucket, r.qty);
            regN++;
          }
        }
        if (now >= short.regDeadline) {
          // PayShort: head day only, strictly oldest-day-first; 16 per tx, 1 tx per block
          let budget =
            Math.floor((3600 / (BLOCK_MS / 1000)) * p.keeperH * p.blockShare) * PAYSHORT_CAP;
          let progress = true;
          while (progress && budget > 0 && short.tallies.length > 0) {
            progress = false;
            const hd = short.tallies[0]!.day;
            const dayReqs = queue.filter(
              (r) => r.registered && r.paidMs === null && r.bucket === hd,
            );
            if (p.keeperOrder === "smallest") dayReqs.sort((a, b) => a.qty - b.qty || a.id - b.id);
            for (const r of dayReqs) {
              if (budget <= 0) break;
              for (const sh of shards) {
                if (tryPay(sh, day, r.qty)) {
                  r.paidMs = now;
                  paid += r.qty;
                  sweepSinks += 1;
                  budget--;
                  txThisStep += 1 / PAYSHORT_CAP;
                  short.tallies = tallySub(short.tallies, hd, r.qty) ?? short.tallies;
                  progress = true;
                  break;
                }
              }
            }
            // a head day with unpaid Requests that do not fit blocks every later day
            if (!progress) break;
          }
          // limit-bound in short mode too: a registered Request no shard's caps have room for
          for (const r of queue) {
            if (r.registered && r.paidMs === null && capsRefuseEverywhere(r.qty, day)) {
              noteLimitBound(h);
              break;
            }
          }
        }
      }
      settleTxTotal += txThisStep;
      maxSettleTxPerHour = Math.max(maxSettleTxPerHour, Math.ceil(txThisStep));
    }

    queue = queue.filter((r) => r.paidMs === null);
    const q = queue.reduce((a, r) => a + r.qty, 0);
    if (q > peakQueue) peakQueue = q;
  }

  // -- results ---------------------------------------------------------------------
  const endMs = t0 + totalH * HOUR_MS;
  let maxWait = 0;
  let worstReq: Req | null = null;
  let e2e = 0;
  const waits: number[] = [];
  for (const r of all) {
    const w = (r.paidMs ?? endMs) - r.createdMs;
    if (w > maxWait) {
      maxWait = w;
      worstReq = r;
    }
    if (!r.viaInstant) waits.push(w);
    const e = (r.paidMs ?? endMs) - r.origMs;
    if (e > e2e) e2e = e;
  }
  waits.sort((a, b) => a - b);
  const pct = (x: number) =>
    waits.length ? waits[Math.min(waits.length - 1, Math.floor(x * waits.length))]! : 0;
  const unpaid = queue.reduce((a, r) => a + r.qty, 0);
  const maxShardCap = shardCap(daily, K);
  const unpayable = queue
    .filter((r) => r.qty > maxShardCap)
    .reduce((a, r) => Math.max(a, r.qty), 0);
  const maxWaitDays = maxWait / DAY_MS;
  return {
    requests: all.length,
    demand: demand / TSRA,
    paid: paid / TSRA,
    paidInstant: paidInstant / TSRA,
    unpaid: unpaid / TSRA,
    maxWaitDays,
    peakQueue: peakQueue / TSRA,
    shortDays: shortHours / 24,
    shortEntries,
    raisedAtH,
    limitBoundAtH,
    unpayableAtLimits: unpayable / TSRA,
    sleeveExhausted,
    e2eMaxDays: p.composition ? e2e / DAY_MS : null,
    maxSettleTxPerHour,
    settleTxTotal: Math.round(settleTxTotal),
    sweepTx: Math.ceil(sweepSinks / 20),
    waitP50Days: pct(0.5) / DAY_MS,
    waitP95Days: pct(0.95) / DAY_MS,
    worstRequest: worstReq
      ? {
          qty: (worstReq as Req).qty / TSRA,
          createdH: Math.round(((worstReq as Req).createdMs - t0) / HOUR_MS),
          paidH:
            (worstReq as Req).paidMs === null
              ? null
              : Math.round(((worstReq as Req).paidMs! - t0) / HOUR_MS),
        }
      : null,
    pass: unpaid === 0 && maxWaitDays <= 7,
  };
}
