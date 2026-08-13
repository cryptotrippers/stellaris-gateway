import { APP_NETWORK, NETWORK_LABEL, IS_UNEXPECTED_MAINNET } from "@/lib/network";
import { AlertTriangle, Info } from "lucide-react";

/**
 * Persistent network notice. In the normal (Preprod) case this stays calm and
 * plain-language; the loud red state is reserved for an actual misconfiguration.
 */
export function NetworkBadge() {
  const isMainnet = APP_NETWORK === "mainnet";
  const danger = IS_UNEXPECTED_MAINNET;
  const Icon = danger ? AlertTriangle : Info;
  return (
    <span
      title={
        IS_UNEXPECTED_MAINNET
          ? "CONFIGURATION ERROR: the app resolved to Cardano Mainnet, but this deployment is Preprod-only. Do not sign transactions."
          : isMainnet
            ? "App is pointed at Cardano Mainnet. Transactions use real ADA."
            : `Demo network (${NETWORK_LABEL}). Everything here uses test funds — no real money is involved.`
      }
      className={
        "inline-flex items-center gap-1 rounded-full px-2 py-1 text-[10px] font-semibold ring-1 " +
        (danger
          ? "bg-destructive/15 text-destructive ring-destructive/50 uppercase tracking-widest animate-pulse"
          : "bg-secondary text-muted-foreground ring-border")
      }
    >
      <Icon className="h-3 w-3" />
      {IS_UNEXPECTED_MAINNET
        ? `${NETWORK_LABEL} — MISCONFIGURED`
        : isMainnet
          ? "Live network"
          : "Demo network — funds aren't real"}
    </span>
  );
}
