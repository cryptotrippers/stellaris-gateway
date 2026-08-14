import { AlertTriangle } from "lucide-react";
import { useVaultHoldings } from "@/hooks/useVaultHoldings";
import { MyVaultHoldingsCard } from "@/components/vault/MyVaultHoldingsCard";
import { WithdrawVaultCard } from "@/components/vault/WithdrawVaultCard";

/**
 * Funds sent to the earlier single-owner vault script for this project.
 *
 * That script is separate from the shared project vault, so its balance never
 * turns into shares. The card only appears when the connected wallet actually
 * has money stuck there, and its only purpose is to get it back out.
 */
export function LegacyVaultCard({ assetId }: { assetId: string }) {
  const { holdings, totalAda, isLoading, enabled } = useVaultHoldings([assetId]);

  if (!enabled || isLoading || holdings.length === 0) return null;

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-accent/40 bg-accent/10 p-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <AlertTriangle className="h-4 w-4 text-accent" /> Funds in the earlier vault
        </h3>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          {totalAda.toFixed(2)} tADA of yours sits in this project&apos;s earlier, single-owner
          vault. That is a different on-chain contract from the shared project vault above, so it
          does not earn shares or returns. Withdraw it here, then deposit again in
          &ldquo;Deposit &amp; redeem shares&rdquo; to join the shared vault.
        </p>
      </div>

      <MyVaultHoldingsCard assetIds={[assetId]} title="Earlier vault · your funds" />
      <WithdrawVaultCard assetId={assetId} />
    </div>
  );
}
