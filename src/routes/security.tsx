import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Shield, KeyRound, Clock, MapPin, Fingerprint, ShieldCheck, ShieldAlert, Monitor, Smartphone } from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import { Badge } from "@/components/ui/StatusBadge";

export const Route = createFileRoute("/security")({
  head: () => ({
    meta: [
      { title: "Security Command Center · Stellaris Finance" },
      { name: "description", content: "Institutional-grade security: MFA, hardware wallets, 24h timelocks, withdrawal whitelisting, and live session monitoring." },
      { property: "og:title", content: "Security Command Center · Stellaris" },
      { property: "og:description", content: "Toggle security layers, monitor live sessions, and review audit logs." },
    ],
  }),
  component: SecurityPage,
});

function SecurityPage() {
  const [mfa, setMfa] = useState(true);
  const [hwWallet, setHwWallet] = useState(true);
  const [whitelist, setWhitelist] = useState(true);
  const [timelock, setTimelock] = useState(true);
  const [mfaSetupOpen, setMfaSetupOpen] = useState(false);

  const score = [mfa, hwWallet, whitelist, timelock].filter(Boolean).length;
  const scorePct = (score / 4) * 100;

  return (
    <AppShell>
      <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
        <div>
          <div className="text-[11px] uppercase tracking-[0.22em] text-primary">Security</div>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight text-foreground">Command Center</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">Toggle security layers, review live sessions, and audit every institutional-grade action.</p>
        </div>
        <div className="card-institutional p-4 min-w-[240px]">
          <div className="flex items-center gap-2">
            {score === 4 ? <ShieldCheck className="h-5 w-5 text-success" /> : <ShieldAlert className="h-5 w-5 text-warning" />}
            <div className="text-[10px] uppercase tracking-widest text-muted-foreground">Security Score</div>
          </div>
          <div className="number-display mt-1 text-2xl font-semibold text-foreground">{score}/4 layers</div>
          <div className="mt-2 h-1.5 rounded-full bg-secondary overflow-hidden">
            <div className="h-full bg-gradient-primary" style={{ width: `${scorePct}%` }} />
          </div>
        </div>
      </div>

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <SecurityToggle icon={KeyRound} title="Multi-Factor Authentication" desc="Require TOTP or Yubikey for all sensitive actions." on={mfa} setOn={v => v ? setMfaSetupOpen(true) : setMfa(false)} required />
        <SecurityToggle icon={Fingerprint} title="Hardware Wallet Enforcement" desc="Only allow signing from Lace, Eternl (hardware mode), Ledger, or Yubikey." on={hwWallet} setOn={setHwWallet} />
        <SecurityToggle icon={MapPin} title="Withdrawal Whitelisting" desc="Withdrawals only to pre-approved addresses with 24h cooldown." on={whitelist} setOn={setWhitelist} />
        <SecurityToggle icon={Clock} title="24h Timelock on Withdrawals" desc="All outgoing transactions delayed 24h with revoke window." on={timelock} setOn={setTimelock} />
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-[1.3fr_1fr]">
        <div className="card-institutional p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-foreground flex items-center gap-2"><Monitor className="h-4 w-4 text-primary" /> Live Sessions</h2>
            <Badge tone="accent">3 active</Badge>
          </div>
          <SessionMap />
          <ul className="mt-4 divide-y divide-border">
            <SessionRow icon={Monitor} device="MacBook Pro · Chrome 130" loc="Berlin, DE" ip="88.130.***" current />
            <SessionRow icon={Smartphone} device="iPhone 16 · Safari" loc="Berlin, DE" ip="88.130.***" />
            <SessionRow icon={Monitor} device="Windows · Firefox 132" loc="Zurich, CH" ip="46.42.***" />
          </ul>
        </div>

        <div className="card-institutional p-5">
          <h2 className="text-sm font-semibold text-foreground">Audit Log</h2>
          <ul className="mt-3 space-y-2 text-sm">
            <LogRow t="12:04" e="Signed transaction · Nordic Wind III · ₳ 25,000" tone="primary" />
            <LogRow t="11:41" e="Whitelisted address added · addr1q9…j2k" tone="accent" />
            <LogRow t="09:18" e="MFA challenge passed · Yubikey #2" tone="success" />
            <LogRow t="Yesterday" e="Withdrawal timelock started · ₳ 4,200 · 24h" tone="warning" />
            <LogRow t="Yesterday" e="Login from new device · verified" tone="muted" />
          </ul>
        </div>
      </div>

      {mfaSetupOpen && <MFASetup onDone={() => { setMfa(true); setMfaSetupOpen(false); }} onClose={() => setMfaSetupOpen(false)} />}
    </AppShell>
  );
}

function SecurityToggle({ icon: Icon, title, desc, on, setOn, required = false }: { icon: React.ComponentType<{ className?: string }>; title: string; desc: string; on: boolean; setOn: (v: boolean) => void; required?: boolean }) {
  return (
    <div className={`card-institutional p-5 flex items-start gap-4 ${on ? "border-primary/30" : ""}`}>
      <div className={`grid h-11 w-11 place-items-center rounded-xl ${on ? "bg-gradient-primary text-primary-foreground" : "bg-secondary text-muted-foreground"}`}>
        <Icon className="h-5 w-5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          {required && <Badge tone="accent">Required</Badge>}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{desc}</p>
      </div>
      <button
        onClick={() => setOn(!on)}
        aria-pressed={on}
        className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${on ? "bg-primary" : "bg-border"}`}
      >
        <span className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${on ? "translate-x-5" : ""}`} />
      </button>
    </div>
  );
}

function SessionMap() {
  return (
    <div className="mt-4 relative overflow-hidden rounded-xl border border-border bg-gradient-to-br from-primary/5 to-accent/5 h-40">
      <svg viewBox="0 0 400 160" className="absolute inset-0 h-full w-full">
        <defs>
          <pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse">
            <path d="M 20 0 L 0 0 0 20" fill="none" stroke="currentColor" strokeWidth="0.3" className="text-border" />
          </pattern>
        </defs>
        <rect width="400" height="160" fill="url(#grid)" />
        {/* pseudo continents */}
        <path d="M40,60 q30,-20 70,-10 t60,20 q20,20 -20,30 t-70,0 t-40,-40z" fill="oklch(0.36 0.19 264 / 0.15)" />
        <path d="M200,40 q40,-10 80,10 t50,50 q-20,30 -60,20 t-70,-30z" fill="oklch(0.36 0.19 264 / 0.15)" />
        {/* dots */}
        {[{ x: 210, y: 62, c: "success" }, { x: 210, y: 66, c: "success" }, { x: 200, y: 60, c: "accent" }].map((d, i) => (
          <g key={i}>
            <circle cx={d.x} cy={d.y} r="4" className={d.c === "success" ? "fill-success" : "fill-accent"} />
            <circle cx={d.x} cy={d.y} r="10" className={d.c === "success" ? "fill-success" : "fill-accent"} opacity="0.25">
              <animate attributeName="r" values="4;14;4" dur="2.4s" repeatCount="indefinite" />
              <animate attributeName="opacity" values="0.35;0;0.35" dur="2.4s" repeatCount="indefinite" />
            </circle>
          </g>
        ))}
      </svg>
    </div>
  );
}

function SessionRow({ icon: Icon, device, loc, ip, current }: { icon: React.ComponentType<{ className?: string }>; device: string; loc: string; ip: string; current?: boolean }) {
  return (
    <li className="flex items-center gap-3 py-3">
      <div className="grid h-9 w-9 place-items-center rounded-lg bg-secondary text-muted-foreground">
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground truncate">{device}</span>
          {current && <Badge tone="success">This device</Badge>}
        </div>
        <div className="text-[11px] text-muted-foreground">{loc} · {ip}</div>
      </div>
      {!current && <button className="text-xs font-medium text-destructive hover:underline">Revoke</button>}
    </li>
  );
}

function LogRow({ t, e, tone }: { t: string; e: string; tone: "primary" | "accent" | "success" | "warning" | "muted" }) {
  const dot = { primary: "bg-primary", accent: "bg-accent", success: "bg-success", warning: "bg-warning", muted: "bg-muted-foreground/40" }[tone];
  return (
    <li className="flex items-start gap-3 rounded-lg px-3 py-2 hover:bg-secondary/50">
      <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
      <div className="min-w-0 flex-1">
        <div className="text-sm text-foreground">{e}</div>
        <div className="text-[11px] text-muted-foreground">{t}</div>
      </div>
    </li>
  );
}

function MFASetup({ onDone, onClose }: { onDone: () => void; onClose: () => void }) {
  const [step, setStep] = useState(0);
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-foreground/40 backdrop-blur-sm p-4" onClick={onClose}>
      <div onClick={e => e.stopPropagation()} className="w-full max-w-md rounded-3xl border border-border bg-surface p-6 shadow-elevated">
        <div className="flex items-center gap-2">
          <Shield className="h-5 w-5 text-primary" />
          <h3 className="text-lg font-semibold text-foreground">Enable MFA</h3>
        </div>
        <ol className="mt-4 space-y-3">
          {["Choose method", "Scan / register", "Verify code"].map((s, i) => (
            <li key={s} className={`flex items-center gap-3 rounded-lg border p-3 ${i === step ? "border-primary bg-primary/5" : "border-border"}`}>
              <div className={`grid h-7 w-7 place-items-center rounded-full text-xs font-semibold ${i < step ? "bg-success text-success-foreground" : i === step ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground"}`}>{i < step ? "✓" : i + 1}</div>
              <span className={`text-sm ${i === step ? "font-semibold text-foreground" : "text-muted-foreground"}`}>{s}</span>
            </li>
          ))}
        </ol>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg px-3 py-2 text-sm text-muted-foreground hover:text-foreground">Cancel</button>
          {step < 2 ? (
            <button onClick={() => setStep(s => s + 1)} className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground">Continue</button>
          ) : (
            <button onClick={onDone} className="rounded-lg bg-gradient-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-glow">Activate MFA</button>
          )}
        </div>
      </div>
    </div>
  );
}
