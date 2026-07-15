import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Code2, Key, Copy, ExternalLink, Zap, Plus, RotateCw, Ban, Trash2, ShieldAlert, Check, Eye, EyeOff, Activity } from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import { Badge } from "@/components/ui/StatusBadge";
import { useApiKeys, apiKeysStore, maskKey, type ApiKey, type ApiKeyEnv } from "@/lib/api-keys-store";

export const Route = createFileRoute("/developers")({
  head: () => ({
    meta: [
      { title: "API & Developer Portal · Stellaris Finance" },
      { name: "description", content: "Institutional API for RealFi data feeds, portfolio state, and vault operations. RESTful + WebSocket + on-chain queries." },
      { property: "og:title", content: "Stellaris Developer Portal" },
      { property: "og:description", content: "Programmatic access to RealFi vaults on Cardano." },
    ],
  }),
  component: Developers,
});

const ENDPOINTS = [
  { method: "GET", path: "/v1/assets", desc: "List all listed vaults with APY, ESG, and risk metadata." },
  { method: "GET", path: "/v1/assets/{id}", desc: "Full detail for a specific vault." },
  { method: "GET", path: "/v1/portfolio", desc: "Authenticated portfolio state for a wallet address." },
  { method: "POST", path: "/v1/orders/invest", desc: "Submit an investment order (requires signed payload)." },
  { method: "GET", path: "/v1/governance/proposals", desc: "SIP index with vote tallies." },
  { method: "WS", path: "/v1/stream/vaults", desc: "Real-time vault state and yield distribution stream." },
];

function Developers() {
  const [tab, setTab] = useState<"quickstart" | "keys" | "reference">("quickstart");
  return (
    <AppShell>
      <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
        <div>
          <div className="text-[11px] uppercase tracking-[0.22em] text-primary">Developers</div>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight text-foreground">API & Institutional Data</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">Programmatic access to Stellaris vaults, portfolio state, and governance. TLS 1.3, HMAC-signed payloads, per-key rate limits.</p>
        </div>
        <Badge tone="accent"><Zap className="h-3 w-3" /> Pro tier active</Badge>
      </div>

      <div className="mt-6 flex items-center gap-1 border-b border-border">
        {(["quickstart", "keys", "reference"] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`relative px-4 py-2.5 text-sm font-medium capitalize ${tab === t ? "text-foreground" : "text-muted-foreground hover:text-foreground"}`}>
            {t === "reference" ? "API Reference" : t}
            {tab === t && <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-primary" />}
          </button>
        ))}
      </div>

      {tab === "quickstart" && (
        <div className="mt-6 grid gap-4 lg:grid-cols-[1.4fr_1fr]">
          <div className="card-institutional p-6">
            <h2 className="text-sm font-semibold text-foreground flex items-center gap-2"><Code2 className="h-4 w-4 text-primary" /> Fetch live vaults</h2>
            <pre className="mt-4 rounded-xl bg-[oklch(0.16_0.04_265)] p-4 text-[12px] leading-relaxed text-[oklch(0.9_0.02_285)] overflow-x-auto font-mono">
{`curl -X GET "https://api.stellaris.fi/v1/assets" \\
  -H "Authorization: Bearer $STL_API_KEY" \\
  -H "X-Stellaris-Version: 2026-07-01"

# → 200 OK
[
  {
    "id": "ceb-02",
    "name": "Nordic Wind Farm Bond Series III",
    "apy": 6.4,
    "risk": "Conservative",
    "esg": "AAA",
    "funded_pct": 91.0,
    "settlement": "cardano-mainnet"
  }
]`}
            </pre>
          </div>
          <div className="card-institutional p-6">
            <h3 className="text-sm font-semibold text-foreground">Rate limits & SLA</h3>
            <ul className="mt-3 space-y-2 text-sm">
              <li className="flex justify-between border-b border-border pb-2"><span className="text-muted-foreground">Requests / min</span><span className="font-medium">6,000</span></li>
              <li className="flex justify-between border-b border-border pb-2"><span className="text-muted-foreground">WS concurrent streams</span><span className="font-medium">64</span></li>
              <li className="flex justify-between border-b border-border pb-2"><span className="text-muted-foreground">Uptime SLA</span><span className="font-medium">99.95%</span></li>
              <li className="flex justify-between"><span className="text-muted-foreground">P95 latency</span><span className="font-medium">42ms</span></li>
            </ul>
            <a href="#" className="mt-4 inline-flex items-center gap-1 text-xs font-medium text-primary">Full changelog <ExternalLink className="h-3.5 w-3.5" /></a>
          </div>
        </div>
      )}

      {tab === "keys" && <KeysPanel />}

      {tab === "reference" && (
        <div className="mt-6 card-institutional overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-secondary/30 text-left text-[10px] uppercase tracking-widest text-muted-foreground">
                <th className="px-4 py-3 font-medium">Method</th>
                <th className="px-4 py-3 font-medium">Path</th>
                <th className="px-4 py-3 font-medium">Description</th>
              </tr>
            </thead>
            <tbody>
              {ENDPOINTS.map((e, i) => (
                <tr key={i} className="border-b border-border/60 last:border-0 hover:bg-secondary/30">
                  <td className="px-4 py-3">
                    <span className={`rounded-md px-2 py-0.5 text-[10px] font-semibold ${e.method === "GET" ? "bg-primary/10 text-primary" : e.method === "POST" ? "bg-success/10 text-success" : "bg-accent/15 text-accent-foreground"}`}>{e.method}</span>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-foreground">{e.path}</td>
                  <td className="px-4 py-3 text-muted-foreground">{e.desc}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AppShell>
  );
}

function KeysPanel() {
  const keys = useApiKeys();
  const [showCreate, setShowCreate] = useState(false);
  const [justCreated, setJustCreated] = useState<ApiKey | null>(null);
  const [reveal, setReveal] = useState<Record<string, boolean>>({});
  const [copied, setCopied] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);

  const totals = useMemo(() => {
    const active = keys.filter(k => k.status === "active").length;
    const calls = keys.reduce((s, k) => s + k.monthlyCalls, 0);
    const cap = keys.reduce((s, k) => s + k.monthlyLimit, 0);
    return { active, revoked: keys.length - active, calls, cap };
  }, [keys]);

  function copy(text: string, id: string) {
    navigator.clipboard?.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(null), 1400);
  }

  return (
    <div className="mt-6 space-y-4">
      <div className="grid gap-3 md:grid-cols-4">
        <StatTile label="Active keys" value={String(totals.active)} icon={<Key className="h-3.5 w-3.5" />} />
        <StatTile label="Revoked" value={String(totals.revoked)} icon={<Ban className="h-3.5 w-3.5" />} />
        <StatTile label="Calls this month" value={totals.calls.toLocaleString()} icon={<Activity className="h-3.5 w-3.5" />} />
        <StatTile label="Monthly capacity" value={totals.cap.toLocaleString()} icon={<Zap className="h-3.5 w-3.5" />} />
      </div>

      <div className="card-institutional p-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-foreground flex items-center gap-2"><Key className="h-4 w-4 text-primary" /> API Keys</h2>
            <p className="text-xs text-muted-foreground mt-0.5">HMAC-signed. Per-key rate limits & monthly quotas. Rotation invalidates the previous secret within 60s.</p>
          </div>
          <button onClick={() => { setShowCreate(true); setJustCreated(null); }} className="inline-flex items-center gap-1.5 rounded-xl bg-gradient-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-glow">
            <Plus className="h-4 w-4" /> New key
          </button>
        </div>

        {justCreated && (
          <div className="mt-4 rounded-xl border border-warning/30 bg-warning/5 p-4">
            <div className="flex items-start gap-2">
              <ShieldAlert className="h-4 w-4 text-warning shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-foreground">Copy this secret now — it will not be shown again.</div>
                <div className="mt-2 flex items-center gap-2 rounded-lg bg-[oklch(0.16_0.04_265)] px-3 py-2">
                  <code className="flex-1 font-mono text-xs text-[oklch(0.9_0.02_285)] break-all">{justCreated.full}</code>
                  <button onClick={() => copy(justCreated.full, "new")} className="inline-flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-[11px] font-semibold text-primary-foreground">
                    {copied === "new" ? <><Check className="h-3 w-3" /> Copied</> : <><Copy className="h-3 w-3" /> Copy</>}
                  </button>
                </div>
                <button onClick={() => setJustCreated(null)} className="mt-2 text-[11px] font-medium text-muted-foreground hover:text-foreground">Dismiss</button>
              </div>
            </div>
          </div>
        )}

        <div className="mt-4 space-y-3">
          {keys.length === 0 && <div className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">No keys yet. Generate one to start calling the API.</div>}
          {keys.map(k => {
            const monthPct = Math.min(100, (k.monthlyCalls / k.monthlyLimit) * 100);
            const minPct = Math.min(100, (k.usedThisMin / k.quotaPerMin) * 100);
            const overQuota = monthPct >= 100;
            return (
              <div key={k.id} className={`rounded-xl border p-4 ${k.status === "revoked" ? "border-border/60 bg-secondary/20 opacity-70" : "border-border bg-surface"}`}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-semibold text-foreground">{k.label}</span>
                      <Badge tone={k.env === "live" ? "success" : "primary"}>{k.env}</Badge>
                      {k.status === "revoked" && <Badge tone="destructive">revoked</Badge>}
                      {overQuota && k.status === "active" && <Badge tone="destructive">quota exceeded</Badge>}
                    </div>
                    <div className="mt-1.5 flex items-center gap-2">
                      <code className="font-mono text-xs text-muted-foreground break-all">
                        {reveal[k.id] && k.status === "active" ? k.full : maskKey(k)}
                      </code>
                      {k.status === "active" && (
                        <button onClick={() => setReveal(r => ({ ...r, [k.id]: !r[k.id] }))} className="text-muted-foreground hover:text-foreground" aria-label="Toggle reveal">
                          {reveal[k.id] ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                        </button>
                      )}
                      <button onClick={() => copy(reveal[k.id] ? k.full : maskKey(k), k.id)} className="text-muted-foreground hover:text-foreground" aria-label="Copy">
                        {copied === k.id ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
                      </button>
                    </div>
                    <div className="mt-1 text-[11px] text-muted-foreground">
                      Created {new Date(k.createdAt).toLocaleDateString()} · Last used {k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : "never"}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {k.status === "active" ? (
                      <>
                        <button
                          onClick={() => {
                            const rotated = apiKeysStore.rotate(k.id);
                            if (rotated) { setJustCreated(rotated); setReveal(r => ({ ...r, [k.id]: false })); }
                          }}
                          className="inline-flex items-center gap-1 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-secondary"
                        >
                          <RotateCw className="h-3 w-3" /> Rotate
                        </button>
                        <button
                          onClick={() => setConfirmRevoke(k.id)}
                          className="inline-flex items-center gap-1 rounded-lg border border-destructive/30 bg-destructive/5 px-2.5 py-1.5 text-xs font-medium text-destructive hover:bg-destructive/10"
                        >
                          <Ban className="h-3 w-3" /> Revoke
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={() => apiKeysStore.remove(k.id)}
                        className="inline-flex items-center gap-1 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:text-destructive"
                      >
                        <Trash2 className="h-3 w-3" /> Delete
                      </button>
                    )}
                  </div>
                </div>

                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <QuotaBar
                    label="Requests / min"
                    value={k.usedThisMin}
                    max={k.quotaPerMin}
                    pct={minPct}
                    disabled={k.status === "revoked"}
                  />
                  <QuotaBar
                    label="Monthly calls"
                    value={k.monthlyCalls}
                    max={k.monthlyLimit}
                    pct={monthPct}
                    disabled={k.status === "revoked"}
                  />
                </div>

                {confirmRevoke === k.id && (
                  <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
                    <div className="text-xs text-foreground">Revoke this key? Active integrations will fail with 401 within 60s.</div>
                    <div className="flex gap-1.5">
                      <button onClick={() => setConfirmRevoke(null)} className="rounded-md border border-border bg-surface px-2.5 py-1 text-xs">Cancel</button>
                      <button onClick={() => { apiKeysStore.revoke(k.id); setConfirmRevoke(null); }} className="rounded-md bg-destructive px-2.5 py-1 text-xs font-semibold text-destructive-foreground">Confirm revoke</button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {showCreate && (
        <CreateKeyDialog
          onClose={() => setShowCreate(false)}
          onCreate={(label, env, qpm, monthly) => {
            const k = apiKeysStore.create(label, env, qpm, monthly);
            setJustCreated(k);
            setShowCreate(false);
          }}
        />
      )}
    </div>
  );
}

function StatTile({ label, value, icon }: { label: string; value: string; icon: React.ReactNode }) {
  return (
    <div className="card-institutional p-4">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-muted-foreground">{icon}{label}</div>
      <div className="number-display mt-1 text-xl font-semibold text-foreground">{value}</div>
    </div>
  );
}

function QuotaBar({ label, value, max, pct, disabled }: { label: string; value: number; max: number; pct: number; disabled?: boolean }) {
  const tone = pct >= 100 ? "bg-destructive" : pct >= 80 ? "bg-warning" : "bg-gradient-primary";
  return (
    <div>
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-muted-foreground">{label}</span>
        <span className="number-display font-medium text-foreground">{value.toLocaleString()} / {max.toLocaleString()}</span>
      </div>
      <div className="mt-1 h-1.5 rounded-full bg-secondary overflow-hidden">
        <div className={`h-full rounded-full ${disabled ? "bg-muted" : tone}`} style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
    </div>
  );
}

function CreateKeyDialog({ onClose, onCreate }: { onClose: () => void; onCreate: (label: string, env: ApiKeyEnv, qpm: number, monthly: number) => void }) {
  const [label, setLabel] = useState("");
  const [env, setEnv] = useState<ApiKeyEnv>("live");
  const [qpm, setQpm] = useState(6000);
  const [monthly, setMonthly] = useState(5_000_000);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-background/70 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="w-full max-w-md card-institutional p-6" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-foreground">Generate API key</h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground" aria-label="Close">✕</button>
        </div>
        <div className="mt-4 space-y-4">
          <div>
            <label className="text-xs font-medium text-muted-foreground">Label</label>
            <input value={label} onChange={e => setLabel(e.target.value)} placeholder="e.g. Trading bot – prod"
              className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-primary" />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Environment</label>
            <div className="mt-1 flex gap-2">
              {(["live", "test"] as ApiKeyEnv[]).map(e => (
                <button key={e} onClick={() => setEnv(e)} className={`flex-1 rounded-lg border px-3 py-2 text-xs font-medium capitalize ${env === e ? "border-primary bg-primary text-primary-foreground" : "border-border bg-surface text-muted-foreground hover:text-foreground"}`}>{e}</button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground">Rate limit (req/min)</label>
              <input type="number" min={100} step={100} value={qpm} onChange={e => setQpm(Number(e.target.value) || 0)}
                className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm number-display outline-none focus:border-primary" />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Monthly quota</label>
              <input type="number" min={1000} step={1000} value={monthly} onChange={e => setMonthly(Number(e.target.value) || 0)}
                className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm number-display outline-none focus:border-primary" />
            </div>
          </div>
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg border border-border bg-surface px-4 py-2 text-sm">Cancel</button>
          <button
            onClick={() => onCreate(label.trim() || `${env === "live" ? "Live" : "Test"} key`, env, Math.max(100, qpm), Math.max(1000, monthly))}
            className="rounded-lg bg-gradient-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-glow"
          >
            Generate
          </button>
        </div>
      </div>
    </div>
  );
}
