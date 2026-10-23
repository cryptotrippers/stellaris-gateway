/**
 * Server-only: read the live Tessera Preprod deployment from Blockfrost and
 * decode every datum (reserve Config/Supply, vault State/Tickets, first-loss,
 * queue Config/Short/shards/Requests/Sinks) into a `TesseraLive` snapshot.
 *
 * Decoding follows contracts/tessera/plutus.json field order exactly (the
 * same layouts the Preprod operator scripts in scripts/tessera build).
 * `summarize` is pure (UTxO lists in, snapshot out) so it can be tested
 * without the network; `fetchTesseraLive` adds the Blockfrost reads.
 */
import { TESSERA_PREPROD as D } from "./tessera-preprod";
import type { TesseraLive } from "./tessera-live.shared";

/** The deployment constants `summarize` reads (the live one by default). */
export type Deployment = {
  reserve: { configUnit: string; supplyUnit: string; tsraUnit: string };
  vault: { stateUnit: string; markerUnit: string };
  firstLoss: { stateUnit: string };
  queue: {
    configUnit: string;
    shortUnit: string;
    requestUnit: string;
    shardUnits: readonly string[];
  };
  tusd: { unit: string };
};

export interface RawUtxo {
  ref: string;
  address: string;
  assets: Record<string, bigint>;
  datum: string | null;
}

/** Plutus-data decoder signature (Lucid's Data.from, injected). */
export type DataFrom = (cbor: string) => unknown;

function asConstr(x: unknown): { index: number; fields: unknown[] } {
  const c = x as { index?: number; fields?: unknown[] };
  if (typeof c?.index !== "number" || !Array.isArray(c.fields))
    throw new Error("expected a constructor");
  return c as { index: number; fields: unknown[] };
}
const big = (x: unknown) => x as bigint;
const num = (x: unknown) => Number(x as bigint);
const bool = (x: unknown) => asConstr(x).index === 1;
const s = (x: unknown) => (x as bigint).toString();

/** Plutus Address → bech32 is done by the caller-supplied encoder. */
export type AddrEncoder = (address: unknown) => string;

const vested = (u: bigint, from: bigint, until: bigint, t: bigint) =>
  t <= from ? 0n : t >= until ? u : (u * (t - from)) / (until - from);

export function summarize(
  at: { reserve: RawUtxo[]; vault: RawUtxo[]; firstLoss: RawUtxo[]; queue: RawUtxo[] },
  dataFrom: DataFrom,
  addr: AddrEncoder,
  now: number,
  d: Deployment = D,
): TesseraLive {
  const holding = (xs: RawUtxo[], unit: string) => {
    const found = xs.filter((u) => (u.assets[unit] ?? 0n) === 1n);
    if (found.length !== 1)
      throw new Error(`expected one UTxO holding ${unit}, found ${String(found.length)}`);
    return found[0]!;
  };
  const inner = (u: RawUtxo) => asConstr(asConstr(dataFrom(u.datum!)).fields[0]).fields;

  // reserve
  const c = inner(holding(at.reserve, d.reserve.configUnit));
  const sp = inner(holding(at.reserve, d.reserve.supplyUnit));
  // vault
  const v = inner(holding(at.vault, d.vault.stateUnit));
  const vestShort = big(v[8]);
  const vestFrom = big(v[10]);
  const vestUntil = big(v[11]);
  const shortShares = big(v[0]);
  const shortNow = big(v[1]) + vested(vestShort, vestFrom, vestUntil, BigInt(now));
  const tickets = at.vault
    .filter((u) => (u.assets[d.vault.markerUnit] ?? 0n) === 1n && u.datum)
    .map((u) => {
      const t = asConstr(dataFrom(u.datum!));
      if (t.index !== 2) return null;
      const f = asConstr(t.fields[0]).fields;
      return { utxo: u.ref, owner: addr(f[0]), value: s(f[1]), claimAfter: num(f[3]) };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
  // first-loss
  const fl = asConstr(dataFrom(holding(at.firstLoss, d.firstLoss.stateUnit).datum!)).fields;
  // queue
  const qc = inner(holding(at.queue, d.queue.configUnit));
  const sh = inner(holding(at.queue, d.queue.shortUnit));
  const shards = d.queue.shardUnits.map((unit, index) => {
    const u = holding(at.queue, unit);
    const f = inner(u);
    return {
      index,
      utxo: u.ref,
      tusd: (u.assets[d.tusd.unit] ?? 0n).toString(),
      day: num(f[0]),
      paidDay: s(f[1]),
      month: num(f[2]),
      paidMonth: s(f[3]),
    };
  });
  const requests = at.queue
    .filter((u) => (u.assets[d.queue.requestUnit] ?? 0n) === 1n && u.datum)
    .map((u) => {
      const f = inner(u);
      return {
        utxo: u.ref,
        owner: f[0] as string,
        payoutTo: addr(f[1]),
        qty: s(f[2]),
        payableAfter: num(f[4]),
      };
    });
  const sinks = at.queue.filter((u) => {
    if (!u.datum) return false;
    try {
      return asConstr(dataFrom(u.datum)).index === 2;
    } catch {
      return false;
    }
  });

  return {
    fetchedAt: now,
    reserve: {
      mintedSupply: s(sp[0]),
      attestedReserve: s(sp[1]),
      mintCap: s(sp[2]),
      attestationEpoch: num(sp[3]),
      attestedAt: num(sp[4]),
      attestationFreshUntil: num(sp[4]) + 604_800_000,
      committee: { threshold: num(c[1]), size: (c[0] as string[]).length },
      paused: bool(c[2]),
      kyc: { mint: bool(c[3]), redeem: bool(c[4]), stake: bool(c[5]) },
      vaultPolicy: c[7] as string,
      configEpoch: num(c[9]),
      supplyEpoch: num(sp[5]),
    },
    vault: {
      shortShares: shortShares.toString(),
      shortAssets: s(v[1]),
      longShares: s(v[2]),
      longAssets: s(v[3]),
      vestShort: vestShort.toString(),
      vestLong: s(v[9]),
      vestFrom: Number(vestFrom),
      vestUntil: Number(vestUntil),
      priceE6: (shortShares === 0n ? 1_000_000n : (shortNow * 1_000_000n) / shortShares).toString(),
      ticketEscrow: s(v[5]),
      lossIndex: s(v[4]),
      bounds: {
        longWeightBps: num(v[12]),
        shortCooldownMs: num(v[13]),
        longLockMs: num(v[14]),
        protocolBps: num(v[15]),
      },
      treasuryAddress: addr(v[17]),
      epoch: num(v[18]),
      tickets,
    },
    firstLoss: { balance: s(fl[0]), epoch: num(fl[1]) },
    queue: {
      config: {
        settleDelayMs: num(qc[2]),
        minRequest: s(qc[3]),
        instantMax: s(qc[4]),
        settleTip: s(qc[5]),
        dailyLimit: s(qc[6]),
        monthlyLimit: s(qc[7]),
        shards: num(qc[8]),
        graceMs: num(qc[9]),
        suspendedUntil: num(qc[10]),
      },
      shortActive: bool(sh[0]),
      shards,
      requests,
      sinks: {
        count: sinks.length,
        tsra: sinks.reduce((a, u) => a + (u.assets[d.reserve.tsraUnit] ?? 0n), 0n).toString(),
      },
    },
  };
}

interface BfUtxo {
  tx_hash: string;
  output_index: number;
  address: string;
  amount: Array<{ unit: string; quantity: string }>;
  inline_datum: string | null;
}

async function utxosAt(address: string): Promise<RawUtxo[]> {
  const { bfGet } = await import("./blockfrost-fetch.server");
  const out: RawUtxo[] = [];
  for (let page = 1; page <= 20; page++) {
    const rows =
      (await bfGet<BfUtxo[]>(`/addresses/${address}/utxos?count=100&page=${String(page)}`)) ?? [];
    for (const r of rows)
      out.push({
        ref: `${r.tx_hash}#${String(r.output_index)}`,
        address: r.address,
        assets: Object.fromEntries(r.amount.map((a) => [a.unit, BigInt(a.quantity)])),
        datum: r.inline_datum,
      });
    if (rows.length < 100) break;
  }
  return out;
}

export async function fetchTesseraLive(): Promise<TesseraLive> {
  const { Data, CML } = await import("@lucid-evolution/lucid");
  const [reserve, vault, firstLoss, queue] = await Promise.all([
    utxosAt(D.reserve.address),
    utxosAt(D.vault.address),
    utxosAt(D.firstLoss.address),
    utxosAt(D.queue.address),
  ]);
  const addr: AddrEncoder = (a) => plutusAddressToBech32(a, CML);
  return summarize({ reserve, vault, firstLoss, queue }, (c) => Data.from(c), addr, Date.now());
}

/** Plutus `Address` data → Preprod bech32 (key or script payment, optional inline stake key/script). */
export function plutusAddressToBech32(a: unknown, CML: any): string {
  const f = asConstr(a).fields;
  const cred = (x: unknown) => {
    const c = asConstr(x);
    const h = c.fields[0] as string;
    return c.index === 0
      ? CML.Credential.new_pub_key(CML.Ed25519KeyHash.from_hex(h))
      : CML.Credential.new_script(CML.ScriptHash.from_hex(h));
  };
  const pay = cred(f[0]);
  const st = asConstr(f[1]);
  const networkId = 0;
  if (st.index === 1) return CML.EnterpriseAddress.new(networkId, pay).to_address().to_bech32();
  const inline = asConstr(st.fields[0]);
  if (inline.index !== 0) throw new Error("pointer stake credentials are not supported");
  return CML.BaseAddress.new(networkId, pay, cred(inline.fields[0])).to_address().to_bech32();
}
