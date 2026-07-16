import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Gift, Copy, Check, RefreshCw, Users, Sparkles, ArrowRight, Share2, Trophy } from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import { StellarisWordmark } from "@/components/brand/Logo";
import { Badge } from "@/components/ui/StatusBadge";
import {
  getMyCode,
  regenerateMyCode,
  buildInviteUrl,
  getInviteStats,
  bumpInviteSent,
  getReferredBy,
  getReferralConfirmation,
  REFERRAL_ERROR_COPY,
  type InviteStats,
  type ReferralConfirmation,
} from "@/lib/referral";
import { trackEvent } from "@/lib/analytics";
import { toast } from "sonner";

export const Route = createFileRoute("/invite")({
  head: () => ({
    meta: [
      { title: "Invite friends · Earn ₳25 per signup — Stellaris" },
      { name: "description", content: "Share Stellaris with friends. You get ₳25, they get ₳25 — every time someone joins with your code and makes their first investment." },
      { property: "og:title", content: "Invite friends to Stellaris — earn ₳25 each" },
      { property: "og:description", content: "You get ₳25, they get ₳25. Real-world assets on Cardano, starting from ₳10." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: InvitePage,
});

const REWARD_PER_SIGNUP = 25; // ADA

// Mock leaderboard — swap for real data once Cloud is wired.
const LEADERBOARD = [
  { rank: 1, handle: "0xluna.ada", invites: 148, earned: 3700 },
  { rank: 2, handle: "solstice", invites: 92, earned: 2300 },
  { rank: 3, handle: "farmshares", invites: 71, earned: 1775 },
  { rank: 4, handle: "adawhale", invites: 54, earned: 1350 },
  { rank: 5, handle: "greenyield", invites: 38, earned: 950 },
];

function InvitePage() {
  const [code, setCode] = useState("STELLAR");
  const [stats, setStats] = useState<InviteStats>({ count: 0, lastAt: null });
  const [referredBy, setReferredBy] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<ReferralConfirmation | null>(null);
  const [copied, setCopied] = useState<"code" | "url" | null>(null);

  useEffect(() => {
    setCode(getMyCode());
    setStats(getInviteStats());
    setReferredBy(getReferredBy());
    setConfirmation(getReferralConfirmation());
    // Poll briefly so a wallet connect elsewhere in the app flips this UI live.
    const t = window.setInterval(() => setConfirmation(getReferralConfirmation()), 1500);
    return () => window.clearInterval(t);
  }, []);

  const inviteUrl = buildInviteUrl(code);
  const shareText = `I'm using Stellaris to own fractions of real-world assets (solar farms, coffee estates, real estate) on Cardano — starting from ₳10. Join with my code ${code} and we both get ₳${REWARD_PER_SIGNUP}.`;

  async function copy(kind: "code" | "url", value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(kind);
      trackEvent("referral_copy", { kind });
      bumpInviteSent(`copy_${kind}`);
      setStats(getInviteStats());
      setTimeout(() => setCopied(null), 1600);
    } catch { /* ignore */ }
  }

  async function nativeShare() {
    trackEvent("referral_share", { channel: "native" });
    if (typeof navigator !== "undefined" && "share" in navigator) {
      try {
        await navigator.share({ title: "Join me on Stellaris", text: shareText, url: inviteUrl });
        bumpInviteSent("native");
        setStats(getInviteStats());
        return;
      } catch { /* cancelled */ }
    }
    copy("url", `${shareText} ${inviteUrl}`);
  }

  function externalShare(channel: "x" | "reddit" | "whatsapp" | "telegram" | "email", href: string) {
    trackEvent("referral_share", { channel });
    bumpInviteSent(channel);
    setStats(getInviteStats());
    window.open(href, "_blank", "noopener,noreferrer");
  }

  function regenerate() {
    const next = regenerateMyCode();
    setCode(next);
  }

  const xUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText)}&url=${encodeURIComponent(inviteUrl)}`;
  const redditUrl = `https://www.reddit.com/submit?url=${encodeURIComponent(inviteUrl)}&title=${encodeURIComponent("Fractional real-world assets on Cardano — ₳25 signup bonus")}`;
  const waUrl = `https://wa.me/?text=${encodeURIComponent(`${shareText} ${inviteUrl}`)}`;
  const tgUrl = `https://t.me/share/url?url=${encodeURIComponent(inviteUrl)}&text=${encodeURIComponent(shareText)}`;
  const mailUrl = `mailto:?subject=${encodeURIComponent("Join me on Stellaris — ₳25 signup bonus")}&body=${encodeURIComponent(`${shareText}\n\n${inviteUrl}`)}`;

  const pendingReward = stats.count * REWARD_PER_SIGNUP;

  return (
    <AppShell>
      {/* Hero */}
      <section className="card-institutional bg-gradient-to-br from-primary via-primary to-[oklch(0.28_0.16_264)] p-6 md:p-10 text-primary-foreground overflow-hidden relative">
        <div className="absolute -right-24 -top-24 h-72 w-72 rounded-full bg-accent/25 blur-3xl" />
        <div className="relative max-w-2xl">
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.22em] text-primary-foreground/70">
            <Gift className="h-3.5 w-3.5 text-accent" />
            Invite friends · earn ₳{REWARD_PER_SIGNUP} each
          </div>
          <h1 className="mt-3 text-3xl md:text-4xl font-semibold tracking-tight">
            Give ₳{REWARD_PER_SIGNUP}. Get ₳{REWARD_PER_SIGNUP}.
          </h1>
          <p className="mt-3 text-primary-foreground/75">
            Share your code. When a friend joins with it and makes their first investment, you both get ₳{REWARD_PER_SIGNUP} credited to your portfolio. No cap.
          </p>

          {referredBy && !confirmation && (
            <div className="mt-5 inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/10 px-3 py-1.5 text-xs">
              <Sparkles className="h-3.5 w-3.5 text-accent" />
              Invited by <span className="font-semibold">{referredBy}</span> — connect your wallet to lock in your ₳{REWARD_PER_SIGNUP} bonus.
            </div>
          )}
          {confirmation && (
            <div className="mt-5 inline-flex items-center gap-2 rounded-full border border-success/40 bg-success/15 px-3 py-1.5 text-xs text-primary-foreground">
              <Check className="h-3.5 w-3.5 text-success" />
              Invite from <span className="font-semibold">{confirmation.code}</span> confirmed via {confirmation.reason.replace("_", " ")} — ₳{REWARD_PER_SIGNUP} credited.
            </div>
          )}
        </div>
      </section>


      {/* Code + share */}
      <section className="mt-6 grid gap-6 lg:grid-cols-[1.35fr_1fr]">
        <div className="card-institutional p-6 md:p-8">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-foreground">Your invite code</h2>
            <button
              onClick={regenerate}
              className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <RefreshCw className="h-3.5 w-3.5" /> Regenerate
            </button>
          </div>

          <div className="mt-4 flex items-stretch gap-2">
            <div className="flex-1 rounded-xl border-2 border-dashed border-primary/30 bg-primary/5 px-5 py-4 flex items-center justify-center">
              <span className="number-display text-3xl md:text-4xl font-bold tracking-[0.35em] text-primary">
                {code}
              </span>
            </div>
            <button
              onClick={() => copy("code", code)}
              className="rounded-xl border border-border bg-surface px-4 hover:border-primary/50 hover:bg-secondary transition-colors flex flex-col items-center justify-center gap-1 min-w-[88px]"
              aria-label="Copy code"
            >
              {copied === "code" ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4 text-muted-foreground" />}
              <span className="text-[10px] uppercase tracking-widest text-muted-foreground">
                {copied === "code" ? "Copied" : "Copy"}
              </span>
            </button>
          </div>

          <div className="mt-6">
            <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-2">Your invite link</div>
            <div className="flex items-stretch gap-2">
              <div className="flex-1 rounded-lg border border-border bg-secondary/40 px-3 py-2.5 text-xs font-mono text-foreground truncate">
                {inviteUrl}
              </div>
              <button
                onClick={() => copy("url", inviteUrl)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-xs font-medium hover:border-primary/50 hover:bg-secondary transition-colors"
              >
                {copied === "url" ? <><Check className="h-3.5 w-3.5 text-success" /> Copied</> : <><Copy className="h-3.5 w-3.5" /> Copy</>}
              </button>
            </div>
          </div>

          <div className="mt-6">
            <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-2">Share directly</div>
            <div className="flex flex-wrap gap-2">
              <button onClick={nativeShare} className="inline-flex items-center gap-1.5 rounded-full bg-gradient-to-r from-accent to-primary px-4 py-2 text-xs font-semibold text-white hover:opacity-90 transition-opacity">
                <Share2 className="h-3.5 w-3.5" /> Share
              </button>
              <ShareChip label="Post on X" onClick={() => externalShare("x", xUrl)} />
              <ShareChip label="Reddit" onClick={() => externalShare("reddit", redditUrl)} />
              <ShareChip label="WhatsApp" onClick={() => externalShare("whatsapp", waUrl)} />
              <ShareChip label="Telegram" onClick={() => externalShare("telegram", tgUrl)} />
              <ShareChip label="Email" onClick={() => externalShare("email", mailUrl)} />
            </div>
          </div>
        </div>

        {/* Rewards panel */}
        <div className="grid gap-4">
          <div className="card-institutional p-5">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-foreground">Your rewards</h3>
              <Badge tone="primary">Live</Badge>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-3">
              <Stat label="Invites sent" value={String(stats.count)} icon={<Users className="h-3.5 w-3.5" />} />
              <Stat label="Pending ADA" value={`₳${pendingReward}`} icon={<Gift className="h-3.5 w-3.5" />} />
            </div>
            <p className="mt-4 text-xs text-muted-foreground leading-relaxed">
              Rewards credit automatically once your invitee makes their first investment. Track them in your portfolio.
            </p>
            <Link to="/app" className="mt-4 inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-2 text-xs font-medium text-foreground hover:border-primary/50 hover:bg-secondary transition-colors">
              View portfolio <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>

          <div className="card-institutional p-5">
            <h3 className="text-sm font-semibold text-foreground">How it works</h3>
            <ol className="mt-3 space-y-2.5 text-sm">
              <Step n={1} text="Share your code or link with a friend." />
              <Step n={2} text="They sign up and invest at least ₳10." />
              <Step n={3} text={`You both get ₳${REWARD_PER_SIGNUP} in ADA — no cap.`} />
            </ol>
          </div>
        </div>
      </section>

      {/* Leaderboard */}
      <section className="mt-10">
        <div className="flex items-center gap-2">
          <Trophy className="h-4 w-4 text-accent" />
          <h2 className="text-lg font-semibold text-foreground">Top inviters this month</h2>
        </div>
        <div className="mt-4 card-institutional overflow-hidden">
          <div className="grid grid-cols-[auto_1fr_auto_auto] gap-4 px-5 py-3 border-b border-border bg-secondary/40 text-[10px] uppercase tracking-widest text-muted-foreground">
            <span>#</span>
            <span>Investor</span>
            <span className="text-right">Invites</span>
            <span className="text-right">Earned</span>
          </div>
          {LEADERBOARD.map(row => (
            <div key={row.rank} className="grid grid-cols-[auto_1fr_auto_auto] gap-4 px-5 py-3.5 border-b border-border/60 last:border-0 items-center text-sm">
              <span className={`font-mono font-semibold w-6 ${row.rank <= 3 ? "text-accent" : "text-muted-foreground"}`}>{row.rank}</span>
              <span className="text-foreground truncate">{row.handle}</span>
              <span className="text-right text-foreground tabular-nums">{row.invites}</span>
              <span className="text-right text-primary font-semibold tabular-nums">₳{row.earned.toLocaleString()}</span>
            </div>
          ))}
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Top 10 inviters at month end split a bonus pool of ₳10,000 in addition to per-signup rewards.
        </p>
      </section>

      {/* Fine print */}
      <section className="mt-10 card-institutional p-6">
        <div className="flex items-center gap-2 mb-3">
          <StellarisWordmark />
          <span className="text-[10px] uppercase tracking-widest text-muted-foreground">Terms</span>
        </div>
        <ul className="grid gap-2 text-xs text-muted-foreground md:grid-cols-2">
          <li>• Rewards paid in ADA to your connected Cardano wallet or portfolio balance.</li>
          <li>• Invitee must complete KYC and invest a minimum of ₳10 for rewards to unlock.</li>
          <li>• Self-invites and duplicate accounts are disqualified automatically.</li>
          <li>• Regenerating your code invalidates the previous one for future signups.</li>
        </ul>
      </section>
    </AppShell>
  );
}

function Stat({ label, value, icon }: { label: string; value: string; icon: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-secondary/40 px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-muted-foreground">
        {icon} {label}
      </div>
      <div className="number-display text-xl font-semibold text-foreground mt-1">{value}</div>
    </div>
  );
}

function Step({ n, text }: { n: number; text: string }) {
  return (
    <li className="flex items-start gap-3">
      <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-primary/10 text-[11px] font-semibold text-primary">{n}</span>
      <span className="text-foreground/85">{text}</span>
    </li>
  );
}

function ShareChip({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-2 text-xs font-medium text-foreground hover:border-primary/50 hover:bg-secondary transition-colors"
    >
      {label}
    </button>
  );
}
