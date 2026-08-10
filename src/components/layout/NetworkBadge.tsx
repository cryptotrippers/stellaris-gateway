import { APP_NETWORK, NETWORK_LABEL, IS_UNEXPECTED_MAINNET } from "@/lib/network";
import { AlertTriangle, ShieldCheck } from "lucide-react";

/**
 * Persistent network badge. This deployment is Preprod-only: mainnet is a
 * misconfiguration, so it renders permanently red with a warning icon.
 */
export function NetworkBadge() {
  const isMainnet = APP_NETWORK === "mainnet";
  const danger = !isMainnet || IS_UNEXPECTED_MAINNET; // red for testnet AND for unexpected mainnet
  const Icon = danger ? AlertTriangle : ShieldCheck;
  return (
    <span
      title={
        IS_UNEXPECTED_MAINNET
          ? "CONFIGURATION ERROR: the app resolved to Cardano Mainnet, but this deployment is Preprod-only. Do not sign transactions."
          : isMainnet
            ? "App is pointed at Cardano Mainnet. Transactions use real ADA."
            : "App is pointed at Cardano Preprod testnet. Transactions use test ADA only."
      }
      className={
        "inline-flex items-center gap-1 rounded-full px-2 py-1 text-[10px] font-bold uppercase tracking-widest ring-1 " +
        (danger
          ? "bg-red-500/15 text-red-600 ring-red-500/50 dark:text-red-300 animate-pulse"
          : "bg-emerald-500/15 text-emerald-600 ring-emerald-500/40 dark:text-emerald-300")
      }
    >
      <Icon className="h-3 w-3" />
      {IS_UNEXPECTED_MAINNET ? `${NETWORK_LABEL} — MISCONFIGURED` : NETWORK_LABEL}
    </span>
  );
}

