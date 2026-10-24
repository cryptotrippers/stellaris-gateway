import { AlertTriangle, CheckCircle2, CircleDashed, Loader2, Unplug, XCircle } from "lucide-react";
import { FeatureStatus } from "@/components/brand/FeatureStatus";
import { INVESTOR_STEPS, TX_STATES, type TxState } from "./content";
import { HIW_ICONS } from "./icons";

const TONE: Record<TxState["tone"], { cls: string; Icon: typeof CheckCircle2 }> = {
  neutral: { cls: "border-border bg-muted text-muted-foreground", Icon: Unplug },
  warn: { cls: "border-gold/50 bg-gold/15 text-foreground", Icon: AlertTriangle },
  progress: { cls: "border-teal/40 bg-teal/10 text-teal", Icon: Loader2 },
  ok: { cls: "border-success/40 bg-success/10 text-success", Icon: CheckCircle2 },
  fail: { cls: "border-destructive/40 bg-destructive/10 text-destructive", Icon: XCircle },
};

export function InvestorJourney() {
  return (
    <div>
      <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
        Six steps from first look to following an investment. On the Preprod testnet, all tokens are test tokens with no monetary value.
      </p>
      <ol className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {INVESTOR_STEPS.map((s, i) => {
          const Icon = HIW_ICONS[s.icon];
          return (
            <li key={s.key} className="home-hiw-tile flex flex-col rounded-2xl border border-border bg-card p-5">
              <div className="flex items-center gap-3">
                <span className="home-hiw-num" aria-hidden="true">{String(i + 1).padStart(2, "0")}</span>
                <span className="grid h-10 w-10 place-items-center rounded-xl bg-teal/10 text-teal" aria-hidden="true">
                  <Icon className="h-5 w-5" />
                </span>
              </div>
              <h3 className="mt-4 font-display text-base font-semibold text-foreground">
                <span className="sr-only">Step {i + 1}: </span>
                {s.title}
              </h3>
              <p className="mt-1 flex-1 text-sm leading-relaxed text-muted-foreground">{s.text}</p>
              <div className="mt-4">
                <FeatureStatus stage={s.readiness} />
              </div>
            </li>
          );
        })}
      </ol>

      <figure className="mt-10 rounded-2xl border border-border bg-card p-5 md:p-6">
        <figcaption>
          <span className="font-display text-base font-semibold text-foreground">Transaction states you may see</span>
          <span className="mt-1 block text-xs text-muted-foreground">
            Conceptual guide. Your wallet always shows the real details before you sign.
          </span>
        </figcaption>
        <ol className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {TX_STATES.map((t, i) => {
            const { cls, Icon } = TONE[t.tone];
            return (
              <li key={t.key} className={`flex gap-3 rounded-xl border p-3 ${cls}`}>
                <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <div>
                  <p className="text-sm font-semibold">
                    {i + 1}. {t.label}
                  </p>
                  <p className="mt-0.5 text-xs text-foreground/80">{t.text}</p>
                </div>
              </li>
            );
          })}
        </ol>
        <p className="mt-4 flex items-center gap-1.5 text-xs text-muted-foreground">
          <CircleDashed className="h-3 w-3" aria-hidden="true" /> Each state is shown with an icon and words, not colour alone.
        </p>
      </figure>
    </div>
  );
}
