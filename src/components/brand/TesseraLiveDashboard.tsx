import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Copy, ExternalLink, RefreshCw, Radio } from "lucide-react";
import { BRAND } from "@/config/brand";
import { getTesseraLive } from "@/lib/tessera-live.functions";
import type { TesseraLive } from "@/lib/tessera-live.shared";
import { TESSERA_PREPROD as P, units6, txUrl, addressUrl } from "@/lib/tessera-preprod";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { SectionHeader } from "./SectionHeader";
import { StatusPill } from "./StatusPill";
import {
  attestationState,
  DAY_MS,
  duration,
  firstLossCapPercent,
  LIVE_REFETCH_MS,
  ratioPercent,
  shardDailyUsage,
  vestingPercent,
} from "./tessera-live-display";

const B = BRAND.base.ticker;
const S = BRAND.staked.ticker;
const amount = (value: string | bigint) =>
  units6(value).toLocaleString(undefined, { maximumFractionDigits: 6 });
const short = (value: string) =>
  value.length > 24 ? `${value.slice(0, 12)}…${value.slice(-8)}` : value;
const localDate = (time: number) => new Date(time).toLocaleString();

function OutLink({ href, children, title }: { href: string; children: ReactNode; title?: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={title}
      className="inline-flex max-w-full items-center gap-1 break-all text-teal underline-offset-4 hover:underline"
    >
      {children}
      <ExternalLink className="h-3 w-3 shrink-0" aria-hidden="true" />
    </a>
  );
}

function CopyValue({ value, label }: { value: string; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), 2500);
    return () => clearTimeout(timer);
  }, [state]);
  return (
    <span className="inline-flex max-w-full flex-wrap items-center gap-1">
      <code className="break-all text-xs" title={value}>
        {short(value)}
      </code>
      <Button
        variant="ghost"
        size="icon-sm"
        title={`Copy ${label}`}
        aria-label={`Copy ${label}`}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setState("copied");
          } catch {
            setState("failed");
          }
        }}
      >
        {state === "copied" ? <Check /> : <Copy />}
      </Button>
      <span className="text-xs text-muted-foreground" role="status">
        {state === "copied" ? "Copied" : state === "failed" ? "Copy unavailable" : ""}
      </span>
    </span>
  );
}

function Card({
  title,
  children,
  className = "",
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <article className={`home-card min-w-0 p-5 md:p-6 ${className}`}>
      <h3 className="mb-5 font-display text-lg font-semibold">{title}</h3>
      {children}
    </article>
  );
}
function Facts({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <dl className="space-y-3 text-sm">
      {rows.map(([label, value]) => (
        <div
          className="flex flex-wrap justify-between gap-x-4 gap-y-1 border-b border-border/60 pb-2 last:border-0"
          key={label}
        >
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="max-w-full break-words text-right font-medium tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
function Meter({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="my-4">
      <div className="mb-2 flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
        <span>{label}</span>
        <span>
          {value === null
            ? "Not applicable"
            : `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}%`}
        </span>
      </div>
      <meter
        className="home-meter home-meter-short-ig"
        min={0}
        max={100}
        value={Math.min(100, Math.max(0, value ?? 0))}
        aria-label={label}
      />
    </div>
  );
}
function Badge({ children, active = false }: { children: ReactNode; active?: boolean }) {
  return (
    <span
      className={`inline-flex rounded border px-2 py-1 text-xs font-medium ${active ? "border-teal/30 bg-teal/10 text-teal" : "border-border bg-muted text-muted-foreground"}`}
    >
      {children}
    </span>
  );
}
function Deadline({ at, now, ready }: { at: number; now: number; ready: string }) {
  return (
    <div className="space-y-1">
      <time dateTime={new Date(at).toISOString()}>{localDate(at)}</time>
      <div>
        {at <= now ? (
          <Badge active>{ready}</Badge>
        ) : (
          <span className="text-xs text-muted-foreground">In {duration(at - now)}</span>
        )}
      </div>
    </div>
  );
}
function DataTable({
  headers,
  rows,
  empty,
}: {
  headers: string[];
  rows: ReactNode[][];
  empty: string;
}) {
  if (!rows.length) return <p className="py-4 text-sm text-muted-foreground">{empty}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr>
            {headers.map((h) => (
              <th
                key={h}
                scope="col"
                className="whitespace-nowrap border-b border-border px-3 py-3 font-medium text-muted-foreground first:pl-0"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {row.map((cell, i) => (
                <td key={i} className="border-b border-border/60 px-3 py-4 align-top first:pl-0">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Snapshot({ data, now }: { data: TesseraLive; now: number }) {
  const { reserve: r, vault: v, queue: q } = data;
  const freshness = attestationState(r.attestationFreshUntil, now);
  const tone =
    freshness === "expired"
      ? "border-destructive/30 bg-destructive/10 text-destructive"
      : freshness === "warning"
        ? "border-warning/40 bg-warning/15 text-warning-foreground"
        : "border-teal/30 bg-teal/10 text-teal";
  return (
    <div className="mt-8 grid min-w-0 gap-5 lg:grid-cols-2">
      <Card title={`Reserve (${B})`}>
        <Facts
          rows={[
            ["Minted supply", `${amount(r.mintedSupply)} ${B}`],
            ["Attested reserve", `${amount(r.attestedReserve)} ${B}`],
            ["Mint cap", `${amount(r.mintCap)} ${B}`],
          ]}
        />
        <Meter
          label="Minted vs attested"
          value={ratioPercent(BigInt(r.mintedSupply), BigInt(r.attestedReserve))}
        />
        <div className={`mb-4 rounded-md border p-3 text-sm ${tone}`}>
          <p>
            Attestation age:{" "}
            {r.attestedAt > now ? "Timestamp is in the future" : duration(now - r.attestedAt)}
          </p>
          <p className="mt-1">Fresh until: {localDate(r.attestationFreshUntil)}</p>
          <p className="mt-1 font-medium">
            {freshness === "expired"
              ? "minting paused until re-attested"
              : `${duration(r.attestationFreshUntil - now)} remaining`}
          </p>
        </div>
        <Facts
          rows={[
            ["Committee", `${r.committee.threshold}-of-${r.committee.size}`],
            ["Paused (on-chain flag)", r.paused ? "Yes" : "No"],
          ]}
        />
        <div className="mt-4 flex flex-wrap gap-2">
          {(["mint", "redeem", "stake"] as const).map((key) => (
            <Badge key={key} active={r.kyc[key]}>
              KYC {key}: {r.kyc[key] ? "required" : "not required"}
            </Badge>
          ))}
        </div>
      </Card>
      <Card title={`${S} vault`}>
        <Facts
          rows={[
            [`${S} outstanding`, `${amount(v.shortShares)} ${S}`],
            [`${B} backing`, `${amount(v.shortAssets)} ${B}`],
            ["Price", `1 ${S} = ${units6(v.priceE6).toFixed(6)} ${B}`],
            ["Yield still vesting (scheduled)", `${amount(v.vestShort)} ${B}`],
            ["Tickets escrow", `${amount(v.ticketEscrow)} ${B}`],
          ]}
        />
        <Meter
          label="Yield vesting progress"
          value={vestingPercent(v.vestFrom, v.vestUntil, now)}
        />
        <p className="mb-4 text-xs text-muted-foreground">
          {now >= v.vestUntil ? "Fully vested" : `Fully vested in ${duration(v.vestUntil - now)}`} ·{" "}
          {localDate(v.vestFrom)} → {localDate(v.vestUntil)}
        </p>
        <Facts
          rows={[
            ["Flexible cooldown", `${v.bounds.shortCooldownMs / DAY_MS} days`],
            ["Long lock", `${v.bounds.longLockMs / DAY_MS} days`],
            [
              "Long yield weight",
              `${(v.bounds.longWeightBps / 10000).toLocaleString(undefined, { maximumFractionDigits: 4 })}×`,
            ],
            ["Protocol yield fee", `${v.bounds.protocolBps / 100}%`],
          ]}
        />
      </Card>
      <Card title="Open unstake Tickets">
        <DataTable
          headers={["Owner", `Value (${B})`, "Claimable at", "UTxO"]}
          empty="No open Tickets"
          rows={v.tickets.map((t) => [
            <OutLink href={addressUrl(t.owner)} title={t.owner}>
              {short(t.owner)}
            </OutLink>,
            amount(t.value),
            <Deadline at={t.claimAfter} now={now} ready="Claimable now" />,
            <OutLink href={txUrl(t.utxo.split("#")[0])} title={t.utxo}>
              {short(t.utxo)}
            </OutLink>,
          ])}
        />
      </Card>
      <Card title="First-loss reserve">
        <p className="font-display text-3xl font-semibold tabular-nums">
          {amount(data.firstLoss.balance)}{" "}
          <span className="text-lg text-muted-foreground">{B}</span>
        </p>
        <Meter
          label="Balance as % of the 3% cap"
          value={firstLossCapPercent(data.firstLoss.balance, r.mintedSupply)}
        />
        <p className="text-sm text-muted-foreground">
          Cap: 3% of minted supply · absorbs losses before {S} holders.
        </p>
      </Card>
      <Card title="Redemption queue" className="lg:col-span-2">
        <div className="grid gap-6 md:grid-cols-2">
          <Facts
            rows={[
              ["Settle delay", `${q.config.settleDelayMs / DAY_MS} days`],
              ["Minimum request", `${amount(q.config.minRequest)} ${B}`],
              ["Instant maximum", `${amount(q.config.instantMax)} ${P.tusd.ticker}`],
              ["Daily limit", `${amount(q.config.dailyLimit)} ${P.tusd.ticker}`],
            ]}
          />
          <Facts
            rows={[
              ["Monthly limit", `${amount(q.config.monthlyLimit)} ${P.tusd.ticker}`],
              ["Shards", q.config.shards],
              ["Grace period", `${q.config.graceMs / DAY_MS} days`],
              ["Short mode", q.shortActive ? "Active" : "Inactive"],
              [
                "Suspended",
                q.config.suspendedUntil > now
                  ? `Yes · until ${localDate(q.config.suspendedUntil)}`
                  : "No",
              ],
            ]}
          />
        </div>
        <h4 className="mb-1 mt-6 font-semibold">Shards</h4>
        <DataTable
          headers={["# Index", `${P.tusd.ticker} balance`, "Paid today / per-shard daily cap"]}
          empty="No shards returned"
          rows={q.shards.map((shard) => {
            const usage = shardDailyUsage(
              shard.day,
              shard.paidDay,
              q.config.dailyLimit,
              q.config.shards,
              now,
            );
            return [
              shard.index,
              amount(shard.tusd),
              `${amount(usage.paid)} / ${amount(usage.cap)} ${P.tusd.ticker}`,
            ];
          })}
        />
        <h4 className="mb-1 mt-6 font-semibold">Open Requests</h4>
        <DataTable
          headers={["Owner key hash", `Quantity (${B})`, "Payout address", "Settleable at"]}
          empty="No open Requests"
          rows={q.requests.map((request) => [
            <code title={request.owner}>{short(request.owner)}</code>,
            amount(request.qty),
            <OutLink href={addressUrl(request.payoutTo)} title={request.payoutTo}>
              {short(request.payoutTo)}
            </OutLink>,
            <Deadline at={request.payableAfter} now={now} ready="Settleable now" />,
          ])}
        />
        <p className="mt-5 text-sm font-medium tabular-nums">
          {q.sinks.count} sinks · {amount(q.sinks.tsra)} {B} awaiting burn
        </p>
      </Card>
    </div>
  );
}

function Contracts() {
  return (
    <Card title="Contracts & links" className="mt-5">
      <div className="grid gap-6 md:grid-cols-2">
        {(["reserve", "vault", "firstLoss", "queue"] as const).map((key) => {
          const c = P[key];
          const genesis = "genesisTx" in c ? c.genesisTx : undefined;
          const name =
            key === "firstLoss"
              ? "First-loss"
              : key === "vault"
                ? `${S} vault`
                : key === "queue"
                  ? "Queue"
                  : "Reserve";
          return (
            <div key={key} className="min-w-0 border-b border-border pb-5">
              <h4 className="mb-2 font-semibold">{name}</h4>
              <Facts
                rows={[
                  ["Script hash", <CopyValue value={c.scriptHash} label={`${name} script hash`} />],
                  [
                    "Address",
                    <OutLink href={addressUrl(c.address)} title={c.address}>
                      {short(c.address)}
                    </OutLink>,
                  ],
                  [
                    "Genesis transaction",
                    genesis ? (
                      <OutLink href={txUrl(genesis)} title={genesis}>
                        {short(genesis)}
                      </OutLink>
                    ) : (
                      <span className="text-muted-foreground">
                        Not provided in deployment constants
                      </span>
                    ),
                  ],
                ]}
              />
            </div>
          );
        })}
      </div>
      <div className="mt-6 space-y-3">
        {[
          [B, P.reserve.tsraUnit],
          [S, P.vault.stsraUnit],
          [P.tusd.ticker, P.tusd.unit],
        ].map(([ticker, unit]) => (
          <div key={ticker} className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span>{ticker} token unit</span>
            <CopyValue value={unit} label={`${ticker} token unit`} />
          </div>
        ))}
      </div>
      <div className="mt-6 flex flex-wrap gap-x-6 gap-y-3 text-sm">
        <OutLink href={P.registryPrs.tsra}>{B} · Name registration pending</OutLink>
        <OutLink href={P.registryPrs.stsra}>{S} · Name registration pending</OutLink>
      </div>
    </Card>
  );
}

export function TesseraLiveDashboard() {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const query = useQuery({
    queryKey: ["tessera", "live", P.label],
    queryFn: () => getTesseraLive(),
    enabled: now !== null,
    refetchInterval: LIVE_REFETCH_MS,
    staleTime: LIVE_REFETCH_MS,
    retry: false,
  });
  return (
    <section className="home-container home-section" aria-label="Live on Cardano Preprod">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <StatusPill status="demo" label={`Preprod test deployment · ${P.label}`} />
        <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
          <Radio className="h-3.5 w-3.5 text-teal" aria-hidden="true" />
          Read-only · Cardano Preprod
        </span>
      </div>
      <SectionHeader eyebrow={BRAND.productName} title="Live on Cardano Preprod" />
      <p className="mt-4 max-w-3xl text-sm leading-relaxed text-muted-foreground">
        Test tokens with no monetary value. {P.tusd.ticker} is a Preprod test token, not a
        stablecoin. The datums are provisional.
      </p>
      <p className="mt-3 text-xs text-muted-foreground">
        Source: Blockfrost ·{" "}
        {query.data && now !== null
          ? `Last updated ${new Date(query.data.fetchedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`
          : "Last updated —"}
        {query.isFetching && query.data ? " · Refreshing…" : ""}
      </p>
      {query.isError && (
        <div className="mt-6 rounded-lg border border-destructive/30 bg-card p-5" role="alert">
          <h3 className="font-semibold">
            {query.data ? "The latest refresh is unavailable" : "Live test data is unavailable"}
          </h3>
          <p className="mt-2 text-sm text-muted-foreground">
            We couldn’t read Cardano Preprod right now. The data service may be unavailable or not
            configured.
            {query.data
              ? " The last successful snapshot remains below; balances may be outdated."
              : " Please try again."}
          </p>
          <Button
            className="mt-4"
            variant="outline"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            <RefreshCw className={query.isFetching ? "animate-spin" : ""} />
            Retry
          </Button>
        </div>
      )}
      {query.data && now !== null ? (
        <Snapshot data={query.data} now={now} />
      ) : !query.isError ? (
        <div
          className="mt-8 grid gap-5 lg:grid-cols-2"
          role="status"
          aria-label="Loading live Preprod data"
        >
          {[0, 1, 2, 3].map((i) => (
            <div className="home-card space-y-5 p-6" key={i}>
              <Skeleton className="h-6 w-40" />
              <Skeleton className="h-10 w-3/4" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-4/5" />
            </div>
          ))}
          <span className="sr-only">Loading live Preprod data</span>
        </div>
      ) : null}
      <Contracts />
    </section>
  );
}
