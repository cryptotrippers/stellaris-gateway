import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Copy, Info, Leaf, Link2, TrendingUp, Users } from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import { DeploymentWizard } from "@/components/deploy/DeploymentWizard";
import { Badge } from "@/components/ui/StatusBadge";
import { supabase } from "@/integrations/supabase/client";
import { buildInviteUrl, getInviteStats, getMyCode, isReferralConfirmed } from "@/lib/referral";
import { formatAda, lovelaceToAda } from "@/lib/format";
import { timeAgo } from "@/lib/chain-format";

export const Route = createFileRoute("/stewardship")({
  head: () => ({
    meta: [
      { title: "Stewardship Hub · Stellaris Finance" },
      {
        name: "description",
        content:
          "Track your Stellaris steward referrals and the verified funding and attestation status of every real-world asset in the protocol.",
      },
      { property: "og:title", content: "Impact Stewardship · Stellaris" },
      {
        property: "og:description",
        content:
          "Real referral activity and asset-level attestation status — no projected impact figures.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Stewardship,
});

interface AssetRow {
  id: string;
  name: string;
  category: string;
  issuer: string;
  location: string | null;
  target_lovelace: number;
  raised_lovelace: number;
  funding_status: string;
  data_source: string;
  audit_report_url: string | null;
  oracle_feed_id: string | null;
}

interface FeedRow {
  id: string;
  provider: string;
  pair: string;
  last_price: number | null;
  last_observed_at: string | null;
}

function Stewardship() {
  const assetsQ = useQuery({
    queryKey: ["stewardship-assets"],
    queryFn: async () => {
      const [{ data: assets, error }, { data: feeds }] = await Promise.all([
        supabase
          .from("assets")
          .select(
            "id, name, category, issuer, location, target_lovelace, raised_lovelace, funding_status, data_source, audit_report_url, oracle_feed_id",
          )
          .order("name"),
        supabase.from("oracle_feeds").select("id, provider, pair, last_price, last_observed_at"),
      ]);
      if (error) throw new Error(error.message);
      return {
        assets: (assets ?? []) as AssetRow[],
        feeds: new Map(((feeds ?? []) as FeedRow[]).map((f) => [f.id, f])),
      };
    },
  });

  const assets = assetsQ.data?.assets ?? [];
  const totalRaised = assets.reduce((n, a) => n + Number(a.raised_lovelace || 0), 0);
  const attested = assets.filter((a) => a.oracle_feed_id).length;

  return (
    <AppShell>
      <div className="flex flex-col gap-1">
        <div className="text-[11px] uppercase tracking-[0.22em] text-primary">Stewardship</div>
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">
          Impact Stewards Hub
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Everything on this page is either recorded in the protocol database or held on this
          device. Figures that have not been independently attested are shown as pending rather
          than estimated.
        </p>
      </div>

      <div className="mt-6 grid gap-4 md:grid-cols-4">
        <KPI
          icon={Leaf}
          label="Assets in the protocol"
          value={assetsQ.isLoading ? "…" : String(assets.length)}
          note={assets.length === 0 ? "No assets published yet" : "From the asset registry"}
        />
        <KPI
          icon={TrendingUp}
          label="Capital recorded as raised"
          value={assetsQ.isLoading ? "…" : formatAda(lovelaceToAda(totalRaised))}
          note="Sum of registry values, not an on-chain balance"
        />
        <KPI
          icon={Info}
          label="Assets with an oracle feed"
          value={assetsQ.isLoading ? "…" : `${attested}/${assets.length || 0}`}
          note="Attestation source linked in the registry"
        />
        <KPI
          icon={Users}
          label="Impact outcomes attested"
          value="—"
          note="No verified impact attestations recorded"
        />
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-[1.3fr_1fr]">
        <section className="card-institutional p-6">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-foreground">Asset funding &amp; attestation</h2>
            <Badge tone={attested > 0 ? "success" : "muted"}>
              {attested > 0 ? "Partially attested" : "Attestation pending"}
            </Badge>
          </div>

          {assetsQ.isLoading && (
            <div className="mt-4 text-sm text-muted-foreground">Loading asset registry…</div>
          )}
          {assetsQ.error && (
            <div className="mt-4 text-sm text-destructive">
              Could not load the asset registry right now.
            </div>
          )}
          {assetsQ.data && assets.length === 0 && (
            <div className="mt-4 text-sm text-muted-foreground">
              No assets are published yet. Impact reporting starts once a real-world asset is
              registered and its valuation source is linked.
            </div>
          )}

          <div className="mt-4 flex flex-col gap-3">
            {assets.map((a) => {
              const feed = a.oracle_feed_id ? assetsQ.data?.feeds.get(a.oracle_feed_id) : null;
              const target = Number(a.target_lovelace || 0);
              const raised = Number(a.raised_lovelace || 0);
              const pct = target > 0 ? Math.min(100, (raised / target) * 100) : null;
              return (
                <div key={a.id} className="rounded-xl border border-border p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="text-sm font-medium text-foreground">{a.name}</div>
                      <div className="text-[11px] text-muted-foreground">
                        {a.issuer}
                        {a.location ? ` · ${a.location}` : ""} · {a.category}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge tone={a.data_source === "verified" ? "success" : "warning"}>
                        {a.data_source === "verified" ? "Verified source" : `Source: ${a.data_source}`}
                      </Badge>
                      <Badge tone="muted">{a.funding_status}</Badge>
                    </div>
                  </div>

                  <div className="mt-3">
                    {pct === null ? (
                      <div className="text-xs text-muted-foreground">
                        No funding target recorded — progress cannot be shown.
                      </div>
                    ) : (
                      <>
                        <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
                          <div
                            className="h-full rounded-full bg-primary"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <div className="mt-1 flex justify-between text-[11px] text-muted-foreground tabular-nums">
                          <span>{formatAda(lovelaceToAda(raised))} raised</span>
                          <span>target {formatAda(lovelaceToAda(target))}</span>
                        </div>
                      </>
                    )}
                  </div>

                  <div className="mt-3 flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
                    {feed ? (
                      <span>
                        Valuation feed: {feed.provider} {feed.pair} ·{" "}
                        {feed.last_observed_at
                          ? `observed ${timeAgo(new Date(feed.last_observed_at).getTime())}`
                          : "never observed"}
                      </span>
                    ) : (
                      <span>No valuation feed linked — NAV is unavailable, not estimated.</span>
                    )}
                    {a.audit_report_url && (
                      <a
                        href={a.audit_report_url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-primary hover:underline"
                      >
                        <Link2 className="h-3 w-3" /> Audit report
                      </a>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <StewardReferralCard />
      </div>

      <DeploymentWizard />

      <p className="mt-6 text-[11px] text-muted-foreground">
        Steward activity measures education and distribution reach. It is deliberately kept separate
        from yield, NAV, and reserve reporting, and confers no claim on portfolio performance.
      </p>
    </AppShell>
  );
}

function StewardReferralCard() {
  const [code, setCode] = useState<string | null>(null);
  const [invites, setInvites] = useState<{ count: number; lastAt: number | null }>({
    count: 0,
    lastAt: null,
  });
  const [confirmed, setConfirmed] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setCode(getMyCode());
    setInvites(getInviteStats());
    setConfirmed(isReferralConfirmed());
  }, []);

  const copy = async () => {
    if (!code) return;
    await navigator.clipboard.writeText(buildInviteUrl(code));
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  return (
    <section className="card-institutional p-6">
      <h2 className="text-sm font-semibold text-foreground">Your steward code</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Generated on this device. Share activity below is stored locally, so it reflects this
        browser only — it is not a protocol-wide leaderboard.
      </p>

      <div className="mt-4 flex items-center gap-2 rounded-xl border border-border bg-secondary/40 p-3">
        <code className="flex-1 truncate font-mono text-sm text-foreground">
          {code ?? "Generating…"}
        </code>
        <button
          type="button"
          onClick={copy}
          disabled={!code}
          className="inline-flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground disabled:opacity-50"
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? "Copied" : "Copy link"}
        </button>
      </div>

      <dl className="mt-5 space-y-2 text-sm">
        <Row label="Invites shared from this device" value={String(invites.count)} />
        <Row
          label="Last share"
          value={invites.lastAt ? timeAgo(invites.lastAt) : "never"}
        />
        <Row
          label="Your own invite attribution"
          value={confirmed ? "confirmed" : "not attributed"}
        />
      </dl>

      <div className="mt-5 rounded-lg border border-border bg-background/60 p-3 text-[11px] text-muted-foreground">
        Referred-investor counts and steward rewards are not shown because there is no verified
        server-side record of them yet. They will appear here once referral confirmations are
        recorded against accounts rather than devices.
      </div>
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between rounded-lg bg-secondary/40 px-3 py-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="number-display text-xs text-foreground">{value}</dd>
    </div>
  );
}

function KPI({
  icon: Icon,
  label,
  value,
  note,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  note: string;
}) {
  return (
    <div className="card-institutional p-5">
      <div className="flex items-center gap-2">
        <div className="grid h-9 w-9 place-items-center rounded-xl bg-primary/10 text-primary">
          <Icon className="h-4 w-4" />
        </div>
        <div className="text-[10px] uppercase tracking-widest text-muted-foreground">{label}</div>
      </div>
      <div className="number-display mt-3 text-2xl font-semibold text-foreground">{value}</div>
      <div className="text-xs text-muted-foreground">{note}</div>
    </div>
  );
}
