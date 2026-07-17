import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect, useCallback } from "react";
import { Shield, KeyRound, Clock, MapPin, Fingerprint, ShieldCheck, ShieldAlert, Monitor, Smartphone } from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import { Badge } from "@/components/ui/StatusBadge";
import { supabase } from "@/integrations/supabase/client";

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

type SettingKey = "mfa" | "hardware_wallet" | "withdrawal_whitelist" | "timelock_24h";
type Settings = Record<SettingKey, boolean>;
type SessionRow = { id: string; device: string | null; browser: string | null; location: string | null; last_seen: string; revoked: boolean };
type LogRow = { id: string; action: string; detail: unknown; created_at: string };

const DEFAULT_SETTINGS: Settings = { mfa: false, hardware_wallet: false, withdrawal_whitelist: false, timelock_24h: false };

function SecurityPage() {
  const [userId, setUserId] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [mfaSetupOpen, setMfaSetupOpen] = useState(false);
  const [loading, setLoading] = useState(true);

  const loadAll = useCallback(async (uid: string) => {
    const [settingsRes, sessionsRes, logsRes] = await Promise.all([
      supabase.from("user_security_settings").select("mfa, hardware_wallet, withdrawal_whitelist, timelock_24h").eq("user_id", uid).maybeSingle(),
      supabase.from("security_sessions").select("id, device, browser, location, last_seen, revoked").eq("user_id", uid).eq("revoked", false).order("last_seen", { ascending: false }),
      supabase.from("security_audit_log").select("id, action, detail, created_at").eq("user_id", uid).order("created_at", { ascending: false }).limit(20),
    ]);
    if (settingsRes.data) setSettings(settingsRes.data as Settings);
    setSessions((sessionsRes.data as SessionRow[]) ?? []);
    setLogs((logsRes.data as LogRow[]) ?? []);
  }, []);

  useEffect(() => {
    let mounted = true;
    (async () => {
      const { data } = await supabase.auth.getUser();
      const uid = data.user?.id ?? null;
      if (!mounted) return;
      setUserId(uid);
      if (uid) await loadAll(uid);
      setLoading(false);
    })();
    return () => { mounted = false; };
  }, [loadAll]);

  const updateSetting = useCallback(async (key: SettingKey, value: boolean) => {
    if (!userId) return;
    setSettings(s => ({ ...s, [key]: value }));
    const patch: Partial<Settings> = { [key]: value };
    const { error } = await supabase
      .from("user_security_settings")
      .update(patch)
      .eq("user_id", userId);
    if (error) {
      // Revert on failure
      setSettings(s => ({ ...s, [key]: !value }));
      return;
    }
    // Refresh audit log to reflect the trigger-written entry
    const { data: fresh } = await supabase
      .from("security_audit_log")
      .select("id, action, detail, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(20);
    setLogs((fresh as LogRow[]) ?? []);
  }, [userId]);

  const revokeSession = useCallback(async (id: string) => {
    if (!userId) return;
    setSessions(list => list.filter(s => s.id !== id));
    await supabase.from("security_sessions").update({ revoked: true }).eq("id", id).eq("user_id", userId);
  }, [userId]);

  const score = [settings.mfa, settings.hardware_wallet, settings.withdrawal_whitelist, settings.timelock_24h].filter(Boolean).length;
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

      {!loading && !userId && (
        <div className="mt-6 card-institutional p-6 text-center text-sm text-muted-foreground">
          Sign in to manage your security settings, sessions, and audit log.
        </div>
      )}

      {userId && (
        <>
          <div className="mt-6 grid gap-4 md:grid-cols-2">
            <SecurityToggle icon={KeyRound} title="Multi-Factor Authentication" desc="Require TOTP or Yubikey for all sensitive actions." on={settings.mfa} setOn={v => v ? setMfaSetupOpen(true) : updateSetting("mfa", false)} required />
            <SecurityToggle icon={Fingerprint} title="Hardware Wallet Enforcement" desc="Only allow signing from Lace, Eternl (hardware mode), Ledger, or Yubikey." on={settings.hardware_wallet} setOn={v => updateSetting("hardware_wallet", v)} />
            <SecurityToggle icon={MapPin} title="Withdrawal Whitelisting" desc="Withdrawals only to pre-approved addresses with 24h cooldown." on={settings.withdrawal_whitelist} setOn={v => updateSetting("withdrawal_whitelist", v)} />
            <SecurityToggle icon={Clock} title="24h Timelock on Withdrawals" desc="All outgoing transactions delayed 24h with revoke window." on={settings.timelock_24h} setOn={v => updateSetting("timelock_24h", v)} />
          </div>

          <div className="mt-6 grid gap-4 lg:grid-cols-[1.3fr_1fr]">
            <div className="card-institutional p-5">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-foreground flex items-center gap-2"><Monitor className="h-4 w-4 text-primary" /> Live Sessions</h2>
                <Badge tone="accent">{sessions.length} active</Badge>
              </div>
              <SessionMap />
              {sessions.length === 0 ? (
                <p className="mt-4 text-sm text-muted-foreground">No active sessions recorded.</p>
              ) : (
                <ul className="mt-4 divide-y divide-border">
                  {sessions.map((s, i) => (
                    <SessionRowItem key={s.id} icon={/iphone|android|mobile/i.test(s.device ?? "") ? Smartphone : Monitor} device={`${s.device ?? "Unknown device"}${s.browser ? ` · ${s.browser}` : ""}`} loc={s.location ?? "Unknown"} current={i === 0} onRevoke={() => revokeSession(s.id)} />
                  ))}
                </ul>
              )}
            </div>

            <div className="card-institutional p-5">
              <h2 className="text-sm font-semibold text-foreground">Audit Log</h2>
              {logs.length === 0 ? (
                <p className="mt-3 text-sm text-muted-foreground">No events yet.</p>
              ) : (
                <ul className="mt-3 space-y-2 text-sm">
                  {logs.map(l => <LogRowItem key={l.id} log={l} />)}
                </ul>
              )}
            </div>
          </div>
        </>
      )}

      {mfaSetupOpen && <MFASetup onDone={() => { updateSetting("mfa", true); setMfaSetupOpen(false); }} onClose={() => setMfaSetupOpen(false)} />}
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
        <path d="M40,60 q30,-20 70,-10 t60,20 q20,20 -20,30 t-70,0 t-40,-40z" fill="oklch(0.36 0.19 264 / 0.15)" />
        <path d="M200,40 q40,-10 80,10 t50,50 q-20,30 -60,20 t-70,-30z" fill="oklch(0.36 0.19 264 / 0.15)" />
      </svg>
    </div>
  );
}

function SessionRowItem({ icon: Icon, device, loc, current, onRevoke }: { icon: React.ComponentType<{ className?: string }>; device: string; loc: string; current?: boolean; onRevoke: () => void }) {
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
        <div className="text-[11px] text-muted-foreground">{loc}</div>
      </div>
      {!current && <button onClick={onRevoke} className="text-xs font-medium text-destructive hover:underline">Revoke</button>}
    </li>
  );
}

function formatRelative(iso: string) {
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return d.toLocaleDateString();
}

function toneForAction(action: string): "primary" | "accent" | "success" | "warning" | "muted" {
  if (action.includes("transaction")) return "primary";
  if (action.includes("mfa")) return "success";
  if (action.includes("timelock") || action.includes("withdrawal")) return "warning";
  if (action.includes("login") || action.includes("device")) return "muted";
  return "accent";
}

function LogRowItem({ log }: { log: LogRow }) {
  const tone = toneForAction(log.action);
  const dot = { primary: "bg-primary", accent: "bg-accent", success: "bg-success", warning: "bg-warning", muted: "bg-muted-foreground/40" }[tone];
  const detail = log.detail as Record<string, unknown> | null;
  const label = log.action === "security_setting_changed" && detail
    ? `Setting changed · ${String(detail.setting)} → ${detail.value ? "on" : "off"}`
    : log.action.replace(/_/g, " ");
  return (
    <li className="flex items-start gap-3 rounded-lg px-3 py-2 hover:bg-secondary/50">
      <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
      <div className="min-w-0 flex-1">
        <div className="text-sm text-foreground capitalize">{label}</div>
        <div className="text-[11px] text-muted-foreground">{formatRelative(log.created_at)}</div>
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
