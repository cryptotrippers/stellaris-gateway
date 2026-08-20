import { useEffect, useState } from "react";
import { FileCode2, ShieldCheck, AlertTriangle } from "lucide-react";
import {
  SUSDR_BLUEPRINT_HASH,
  SUSDR_VAULT_VERSION,
  USDR_BLUEPRINT_HASH,
  deriveSusdrVault,
  type AppliedSusdrVault,
} from "@/lib/susdr-vault";
import { APP_NETWORK } from "@/lib/network";

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 border-b border-border/60 py-2 last:border-0 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="break-all font-mono text-[11px] text-foreground">{value}</span>
    </div>
  );
}

/**
 * Read-only identity card for the sUSDr stablecoin vault: the pinned
 * (unapplied) blueprint hashes and the applied script hash + address this
 * build derives at runtime.
 */
export function SusdrContractCard() {
  const [applied, setApplied] = useState<AppliedSusdrVault | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    deriveSusdrVault()
      .then((v) => {
        if (!cancelled) setApplied(v);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
        console.error("[susdr] derive failed", e);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="card-institutional p-6">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <FileCode2 className="h-4 w-4 text-primary" /> sUSDr stablecoin vault — contract identity
      </h3>
      <p className="mt-1 text-xs text-muted-foreground">
        Preprod reference implementation. Blueprint hashes are pinned in the app and re-checked at
        runtime before any transaction is built.
      </p>

      <div className="mt-4">
        <Row label="Network" value={`cardano-${APP_NETWORK}`} />
        <Row label="Vault version" value={String(SUSDR_VAULT_VERSION)} />
        <Row label="Pinned vault blueprint (unapplied)" value={SUSDR_BLUEPRINT_HASH} />
        <Row label="Pinned USDr policy blueprint (unapplied)" value={USDR_BLUEPRINT_HASH} />
        {applied && <Row label="Applied script hash" value={applied.scriptHash} />}
        {applied && <Row label="Applied address" value={applied.address} />}
        {applied && <Row label="sUSDr share token policy" value={applied.policyId} />}
      </div>

      {error ? (
        <p className="mt-3 flex items-start gap-2 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {error}
        </p>
      ) : applied ? (
        <p className="mt-3 flex items-center gap-2 text-xs text-success">
          <ShieldCheck className="h-3.5 w-3.5" /> Blueprint verified against the pinned hash.
        </p>
      ) : (
        <p className="mt-3 text-xs text-muted-foreground">Deriving script identity…</p>
      )}
    </div>
  );
}
