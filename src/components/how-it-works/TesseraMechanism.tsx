import { Link } from "@tanstack/react-router";
import { ArrowRight, AlertTriangle, Clock, Hourglass, ListOrdered, Zap } from "lucide-react";
import { BRAND } from "@/config/brand";
import { Button } from "@/components/ui/button";

const T = BRAND.base.ticker;
const S = BRAND.staked.ticker;

const MECHANISMS = [
  { Icon: Clock, title: "Seven-day yield vesting", text: `Yield earned by the reserve is credited to ${S} gradually over 7 days, not all at once.` },
  { Icon: Hourglass, title: "Seven-day unstake cooldown", text: `Unstaking creates a Ticket. After a 7-day cooldown it can be claimed back as ${T}.` },
  { Icon: ListOrdered, title: "Redemption queue", text: `Redeeming ${T} creates a Request in a daily queue. Timing depends on reserve liquidity.` },
  { Icon: Zap, title: "Instant redemption cap", text: "Instant redemption may be offered up to a cap, when liquidity allows. It can be paused or unavailable." },
  { Icon: AlertTriangle, title: "Loss risk", text: `If reserve assets lose value, ${S} holders can bear losses. Rates are variable and can fall to zero.` },
];

export function TesseraMechanism() {
  return (
    <div>
      <div className="rounded-xl border border-gold/50 bg-gold/10 p-4 text-sm text-foreground">
        <strong>Separate from project cash yield.</strong> {BRAND.productName} is a reserve-backed token mechanism. It is not a project, and its
        yield is not the cash distributions paid by real-world assets. All mechanisms below are conditional; nothing is guaranteed.
      </div>

      <figure className="home-dark-section mt-8 overflow-hidden rounded-2xl p-5 md:p-8">
        <figcaption className="home-eyebrow">Conceptual mechanism · not live data</figcaption>
        <svg viewBox="0 0 640 200" className="mt-4 h-auto w-full" role="img" aria-labelledby="tsra-svg-title">
          <title id="tsra-svg-title">{`Reserve assets back ${T}; staking ${T} gives ${S}, which receives reserve yield vested over 7 days. Unstaking returns ${T} after a 7-day ticket cooldown.`}</title>
          <defs>
            <linearGradient id="hiw-flow" x1="0" x2="1">
              <stop offset="0" stopColor="var(--teal)" />
              <stop offset="1" stopColor="var(--aqua)" />
            </linearGradient>
            <marker id="hiw-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
              <path d="M0 0 L10 5 L0 10 z" fill="var(--aqua)" />
            </marker>
          </defs>
          {[
            { x: 10, label: "Reserve", sub: "assets" },
            { x: 240, label: T, sub: "1 = 1 USD target" },
            { x: 470, label: S, sub: "variable yield" },
          ].map((b) => (
            <g key={b.label}>
              <rect x={b.x} y={50} width={160} height={80} rx={16} fill="color-mix(in oklab, var(--teal) 22%, transparent)" stroke="url(#hiw-flow)" strokeWidth="2" />
              <text x={b.x + 80} y={86} textAnchor="middle" fill="currentColor" fontSize="20" fontWeight="700" fontFamily="var(--font-display)">{b.label}</text>
              <text x={b.x + 80} y={110} textAnchor="middle" fill="currentColor" opacity="0.75" fontSize="12">{b.sub}</text>
            </g>
          ))}
          <path d="M175 80 H235" stroke="url(#hiw-flow)" strokeWidth="3" markerEnd="url(#hiw-arrow)" className="home-hiw-dash" />
          <text x="205" y="70" textAnchor="middle" fill="currentColor" fontSize="11">backs</text>
          <path d="M405 80 H465" stroke="url(#hiw-flow)" strokeWidth="3" markerEnd="url(#hiw-arrow)" className="home-hiw-dash" />
          <text x="435" y="70" textAnchor="middle" fill="currentColor" fontSize="11">stake</text>
          <path d="M465 110 H405" stroke="var(--gold)" strokeWidth="2" strokeDasharray="5 5" markerEnd="url(#hiw-arrow)" />
          <text x="435" y="128" textAnchor="middle" fill="currentColor" fontSize="11">unstake · 7d</text>
          <path d="M90 50 C 90 28, 550 28, 550 46" fill="none" stroke="var(--gold)" strokeWidth="2" markerEnd="url(#hiw-arrow)" />
          <text x="320" y="20" textAnchor="middle" fill="currentColor" fontSize="11">reserve yield, vested over 7 days</text>
          <path d="M320 130 V175" stroke="var(--gold)" strokeWidth="2" strokeDasharray="5 5" markerEnd="url(#hiw-arrow)" />
          <text x="330" y="192" fill="currentColor" fontSize="11">redeem via queue Request · capped instant option</text>
        </svg>
      </figure>

      <ul className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {MECHANISMS.map(({ Icon, title, text }) => (
          <li key={title} className="home-hiw-tile rounded-2xl border border-border bg-card p-5">
            <Icon className="h-5 w-5 text-teal" aria-hidden="true" />
            <h3 className="mt-3 font-display text-base font-semibold text-foreground">{title}</h3>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{text}</p>
            <p className="mt-3 text-xs font-medium text-foreground">Conditional mechanism</p>
          </li>
        ))}
      </ul>

      <div className="mt-8 flex flex-wrap gap-3">
        <Button asChild className="min-h-11">
          <Link to="/tessera">About {BRAND.productName} <ArrowRight /></Link>
        </Button>
        <Button asChild variant="outline" className="min-h-11">
          <Link to="/stake">Staking preview</Link>
        </Button>
        <Button asChild variant="outline" className="min-h-11">
          <Link to="/transparency">Transparency</Link>
        </Button>
      </div>
    </div>
  );
}
