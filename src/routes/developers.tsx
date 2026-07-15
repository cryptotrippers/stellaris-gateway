import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Code2, Key, Copy, ExternalLink, Zap } from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import { Badge } from "@/components/ui/StatusBadge";

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
  const [key] = useState("sk_live_stl_ff2c8a91***");
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

      {tab === "keys" && (
        <div className="mt-6 card-institutional p-6 max-w-3xl">
          <h2 className="text-sm font-semibold text-foreground flex items-center gap-2"><Key className="h-4 w-4 text-primary" /> API Keys</h2>
          <div className="mt-4 space-y-3">
            <div className="flex items-center gap-3 rounded-xl border border-border bg-secondary/40 p-3">
              <div className="flex-1">
                <div className="text-xs text-muted-foreground">Primary (live)</div>
                <div className="font-mono text-sm text-foreground">{key}</div>
              </div>
              <button className="inline-flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground"><Copy className="h-3 w-3" /> Copy</button>
            </div>
            <div className="flex items-center gap-3 rounded-xl border border-border bg-secondary/40 p-3">
              <div className="flex-1">
                <div className="text-xs text-muted-foreground">Sandbox</div>
                <div className="font-mono text-sm text-foreground">sk_test_stl_a71bde42***</div>
              </div>
              <button className="text-xs font-medium text-destructive hover:underline">Rotate</button>
            </div>
          </div>
          <button className="mt-4 rounded-xl bg-gradient-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-glow">Generate new key</button>
        </div>
      )}

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
