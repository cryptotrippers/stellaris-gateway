import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Coins, FileCode2, ShieldCheck } from "lucide-react";
import { APP_NETWORK } from "@/lib/network";
import { listDepositAssets } from "@/lib/deposit-assets.functions";
import type { DepositAsset } from "@/lib/deposit-assets.shared";
import {
  MULTI_BLUEPRINT_HASH,
  MULTI_VAULT_VERSION,
  deriveMultiVault,
  lucidUnitOf,
  unitOfDepositAsset,
} from "@/lib/multi-asset-vault";

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 border-b border-border/60 py-2 last:border-0 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="break-all font-mono text-[11px] text-foreground">{value}</span>
    </div>
  );
}

/**
 * Read-only identity card for the multi-asset vault: the pinned (unapplied)
 * blueprint, plus the address this build derives for each registered deposit
 * denomination. One script, one address per (project, denomination).
 */
export function MultiAssetVaultCard({ assetId = "demo" }: { assetId?: string }) {
  const registryQ = useQuery<DepositAsset[]>({
    queryKey: ["deposit-assets"],
    queryFn: () => listDepositAssets(),
    staleTime: 300_000,
  });

  const units = (registryQ.data ?? []).filter((a) => a.network === APP_NETWORK);

  const derivedQ = useQuery({
    queryKey: ["multi-vault-derive", assetId, units.map((u) => u.id).join(",")],
    enabled: units.length > 0,
    retry: 0,
    queryFn: async () =>
      Promise.all(
        units.map(async (u) => {
          const unit = unitOfDepositAsset(u);
          const applied = await deriveMultiVault(assetId, unit);
          return { symbol: u.symbol, unit: lucidUnitOf(unit), address: applied.address };
        }),
      ),
  });

  return (
    <div className="card-institutional p-6">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <FileCode2 className="h-4 w-4 text-primary" /> Multi-asset vault — contract identity
      </h3>
      <p className="mt-1 text-xs text-muted-foreground">
        One validator, parameterised by{" "}
        <span className="font-mono">(version, asset_id, unit_policy, unit_name)</span>. ADA is the
        empty policy; any Cardano native token plugs in without a source change.
      </p>

      <div className="mt-4">
        <Row label="Network" value={`cardano-${APP_NETWORK}`} />
        <Row label="Vault version" value={String(MULTI_VAULT_VERSION)} />
        <Row label="Pinned blueprint (unapplied)" value={MULTI_BLUEPRINT_HASH} />
        <Row label="Derivation asset_id" value={assetId} />
      </div>

      <div className="mt-4">
        <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-widest text-muted-foreground">
          <Coins className="h-3 w-3" /> Derived addresses per denomination
        </div>
        {registryQ.isError ? (
          <p className="mt-2 flex items-start gap-2 text-xs text-destructive">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            Registry unavailable: {(registryQ.error as Error).message}
          </p>
        ) : registryQ.isLoading || derivedQ.isLoading ? (
          <p className="mt-2 text-xs text-muted-foreground">Deriving script identities…</p>
        ) : units.length === 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">
            No deposit denominations registered for cardano-{APP_NETWORK} yet.
          </p>
        ) : derivedQ.isError ? (
          <p className="mt-2 flex items-start gap-2 text-xs text-destructive">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {(derivedQ.error as Error).message}
          </p>
        ) : (
          <div className="mt-2">
            {(derivedQ.data ?? []).map((d) => (
              <Row key={d.unit} label={`${d.symbol} (${d.unit.slice(0, 20)}…)`} value={d.address} />
            ))}
          </div>
        )}
      </div>

      {derivedQ.data && derivedQ.data.length > 0 && (
        <p className="mt-3 flex items-center gap-2 text-xs text-success">
          <ShieldCheck className="h-3.5 w-3.5" /> Blueprint verified against the pinned hash before
          derivation.
        </p>
      )}
    </div>
  );
}
