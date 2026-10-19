import { Info } from "lucide-react";
import type { ReactNode } from "react";

export const TESTNET_DISCLOSURE =
  "Cardano Preprod testnet. No real-money investment opportunities are currently available.";

/** Calm, always-visible disclosure line. Not alarmist, never dismissible. */
export function DisclosureBanner({ children = TESTNET_DISCLOSURE }: { children?: ReactNode }) {
  return (
    <div role="note" className="border-b border-gold/30 bg-gold/10">
      <div className="home-container flex items-center gap-2 py-2 text-xs text-foreground">
        <Info className="h-3.5 w-3.5 shrink-0 text-gold" aria-hidden="true" />
        <span>{children}</span>
      </div>
    </div>
  );
}
