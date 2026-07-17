import { APP_NETWORK, NETWORK_LABEL } from "@/lib/network";
import { AlertTriangle, ShieldCheck } from "lucide-react";

/**
 * Persistent network badge. Red for testnet, green for mainnet.
 * Placed in the top nav so it's impossible to miss which chain the
 * app is currently pointed at.
 */
export function NetworkBadge() {
  const isMainnet = APP_NETWORK === "mainnet";
  const Icon = isMainnet ? ShieldCheck : AlertTriangle;
  return (
    <span
      title={
        isMainnet
          ? "App is pointed at Cardano Mainnet. Transactions use real ADA."
          : "App is pointed at Cardano Preprod testnet. Transactions use test ADA only."
      }
      className={
        "inline-flex items-center gap-1 rounded-full px-2 py-1 text-[10px] font-bold uppercase tracking-widest ring-1 " +
        (isMainnet
          ? "bg-emerald-500/15 text-emerald-600 ring-emerald-500/40 dark:text-emerald-300"
          : "bg-red-500/15 text-red-600 ring-red-500/50 dark:text-red-300 animate-pulse")
      }
    >
      <Icon className="h-3 w-3" />
      {NETWORK_LABEL}
    </span>
  );
}
