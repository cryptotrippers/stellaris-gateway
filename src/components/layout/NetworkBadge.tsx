import { NETWORK_LABEL, IS_UNEXPECTED_MAINNET } from "@/lib/network";
import { AlertTriangle, Info } from "lucide-react";

/**
 * Persistent network notice. In the normal (Preprod) case this stays calm and
 * plain-language; the loud red state is reserved for an actual misconfiguration.
 */
export function NetworkBadge() {
  const danger = IS_UNEXPECTED_MAINNET;
  const Icon = danger ? AlertTriangle : Info;
  return (
    <span
      title={
        // The app refuses mainnet (network.ts): APP_NETWORK stays "preprod" even
        // when mainnet is requested, so there is no "live network" state.
        IS_UNEXPECTED_MAINNET
          ? "CONFIGURATION ERROR: mainnet was requested and refused. The app is still on Preprod; fix VITE_BLOCKFROST_NETWORK."
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
        : "Demo network — funds aren't real"}
    </span>
  );
}
