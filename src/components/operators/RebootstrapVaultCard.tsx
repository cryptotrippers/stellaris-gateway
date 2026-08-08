/**
 * Admin-only re-bootstrap.
 *
 * When the yield validator source changes, its applied script hash — and so its
 * Preprod address — changes with it. The registry still points at the old
 * address, which is now an orphaned script holding real funds. This card:
 *
 *   1. detects the drift (stored address vs freshly derived address),
 *   2. shows what is still locked at the old address and guides the withdrawal,
 *   3. deploys a fresh state UTxO at the new address and re-points the registry.
 *
 * Deploying before draining the old vault is allowed but warned about loudly —
 * the old UTxOs stay spendable by their committee either way.
 */

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ExternalLink,
  Loader2,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import type { AssetVaultRow } from "@/lib/asset-vaults.shared";
import { registerAssetVault } from "@/lib/asset-vaults.functions";
import { bootstrapYieldVault, deriveYieldVaultAddress } from "@/lib/vault-bootstrap";
import { getVaultChainState } from "@/lib/yield-chain.functions";
import { YIELD_VAULT_VERSION } from "@/lib/yield-vault";
import { cardanoscanAddress, cardanoscanTx, lovelaceToAda, short } from "@/lib/chain-format";

interface Drift {
  vault: AssetVaultRow;
  newAddress: string;
  newScriptHash: string;
}

export function RebootstrapVaultCard({
  vaults,
  disabled,
  onDone,
}: {
  vaults: AssetVaultRow[];
  disabled: boolean;
  onDone: () => void;
}) {
  const [drifted, setDrifted] = useState<Drift[] | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);

  const key = useMemo(
    () => vaults.map((v) => `${v.asset_id}:${v.script_address}`).join("|"),
    [vaults],
  );

  useEffect(() => {
    let cancelled = false;
    if (vaults.length === 0) {
      setDrifted([]);
      return;
    }
    setDrifted(null);
    setCheckError(null);
    (async () => {
      const out: Drift[] = [];
      for (const v of vaults) {
        const script = await deriveYieldVaultAddress(v.asset_id);
        if (script.address !== v.script_address || script.scriptHash !== v.script_hash) {
          out.push({ vault: v, newAddress: script.address, newScriptHash: script.scriptHash });
        }
      }
      if (!cancelled) setDrifted(out);
    })().catch((e: unknown) => {
      if (!cancelled) setCheckError(e instanceof Error ? e.message : String(e));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return (
    <section className="mt-10 card-institutional p-6">
      <div className="flex items-center gap-2">
        <RefreshCw className="h-4 w-4 text-primary" />
        <h2 className="text-sm font-medium text-foreground">Re-bootstrap after a script upgrade</h2>
      </div>
      <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
        The vault address is derived from the compiled validator. When the contract changes, every
        registered vault points at an address the new script can no longer spend into. Deploy the
        updated script, re-point the registry, and drain the superseded address.
      </p>

      {checkError && (
        <div className="mt-4 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{checkError}</span>
        </div>
      )}

      {drifted === null && !checkError && (
        <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Comparing registered addresses with the
          current script…
        </div>
      )}

      {drifted?.length === 0 && (
        <div className="mt-4 flex items-start gap-2 rounded-md border border-success/40 bg-success/10 p-3 text-sm text-success">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Every registered vault matches the current yield validator (v
            {String(YIELD_VAULT_VERSION)}). Nothing to re-bootstrap.
          </span>
        </div>
      )}

      <div className="mt-4 flex flex-col gap-4">
        {(drifted ?? []).map((d) => (
          <DriftRow key={d.vault.id} drift={d} disabled={disabled} onDone={onDone} />
        ))}
      </div>
    </section>
  );
}

function DriftRow({
  drift,
  disabled,
  onDone,
}: {
  drift: Drift;
  disabled: boolean;
  onDone: () => void;
}) {
  const { vault, newAddress, newScriptHash } = drift;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  const oldState = useQuery({
    queryKey: ["vault-chain-state", vault.script_address],
    queryFn: () => getVaultChainState({ data: { address: vault.script_address } }),
    retry: 0,
  });

  const stranded = oldState.data ? BigInt(oldState.data.lockedLovelace ?? "0") : null;
  const positions = oldState.data?.positions.length ?? 0;

  const redeploy = async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await bootstrapYieldVault({
        assetId: vault.asset_id,
        operators: vault.operator_key_hashes,
        threshold: vault.signature_threshold,
      });
      await registerAssetVault({
        data: {
          assetId: res.assetId,
          vaultVersion: res.vaultVersion,
          network: vault.network === "mainnet" ? "mainnet" : "preprod",
          scriptHash: res.scriptHash,
          scriptAddress: res.address,
          operators: res.operators,
          threshold: res.threshold,
          bootstrapTxHash: res.txHash,
          reportingCadence: vault.reporting_cadence ?? undefined,
        },
      });
      setTxHash(res.txHash);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-warning/40 bg-warning/5 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm font-medium text-foreground">{vault.asset_id}</div>
        <div className="text-[11px] text-muted-foreground">
          registry v{vault.vault_version} · script v{String(YIELD_VAULT_VERSION)} ·{" "}
          {vault.signature_threshold}-of-{vault.operator_key_hashes.length}
        </div>
      </div>

      <div className="mt-3 grid gap-3 text-xs md:grid-cols-2">
        <div>
          <div className="text-muted-foreground">Superseded address (funds live here)</div>
          <a
            href={cardanoscanAddress(vault.script_address)}
            target="_blank"
            rel="noreferrer"
            className="mt-1 inline-flex items-center gap-1 break-all font-mono text-foreground hover:text-primary"
          >
            {vault.script_address} <ExternalLink className="h-3 w-3 shrink-0" />
          </a>
          <div className="mt-1 font-mono text-[11px] text-muted-foreground">
            hash {short(vault.script_hash, 10, 6)}
          </div>
        </div>
        <div>
          <div className="flex items-center gap-1 text-muted-foreground">
            <ArrowRight className="h-3 w-3" /> New address from the current script
          </div>
          <div className="mt-1 break-all font-mono text-foreground">{newAddress}</div>
          <div className="mt-1 font-mono text-[11px] text-muted-foreground">
            hash {short(newScriptHash, 10, 6)}
          </div>
        </div>
      </div>

      <div className="mt-3 rounded-md border border-border bg-background/60 p-3 text-xs">
        <div className="font-medium text-foreground">Withdraw before you retire the old vault</div>
        {oldState.isLoading && (
          <div className="mt-1 flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> Reading the old address…
          </div>
        )}
        {oldState.error && (
          <div className="mt-1 text-muted-foreground">
            Could not read the old address right now — check it on Cardanoscan before proceeding.
          </div>
        )}
        {oldState.data && (
          <div className="mt-1 text-muted-foreground">
            {stranded && stranded > 0n ? (
              <>
                <span className="text-warning">
                  {lovelaceToAda(stranded)} ADA still locked
                </span>{" "}
                across {positions} position UTxO{positions === 1 ? "" : "s"} plus the state UTxO.
              </>
            ) : (
              <span className="text-success">The old address is empty — safe to retire.</span>
            )}
          </div>
        )}
        <ol className="mt-2 list-decimal space-y-1 pl-4 text-muted-foreground">
          <li>Connect the master wallet on the same network as this vault.</li>
          <li>
            Open the vault panel for <span className="font-mono">{vault.asset_id}</span> and redeem
            every position at the superseded address so depositors are made whole.
          </li>
          <li>
            Have {vault.signature_threshold} of {vault.operator_key_hashes.length} operators sign the
            final spend of the old state UTxO back to the treasury.
          </li>
          <li>
            Confirm the{" "}
            <a
              href={cardanoscanAddress(vault.script_address)}
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              old address
            </a>{" "}
            shows a zero balance, then deploy below.
          </li>
        </ol>
      </div>

      {error && (
        <div className="mt-3 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {txHash && (
        <div className="mt-3 flex items-start gap-2 rounded-md border border-success/40 bg-success/10 p-3 text-sm text-success">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            New ledger deployed and the registry now points at the new address.{" "}
            <a href={cardanoscanTx(txHash)} target="_blank" rel="noreferrer" className="underline">
              View transaction
            </a>
          </span>
        </div>
      )}

      <button
        type="button"
        onClick={redeploy}
        disabled={disabled || busy || Boolean(txHash)}
        className="mt-4 inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
        {busy ? "Awaiting wallet signature…" : "Deploy updated script & re-point registry"}
      </button>
      {disabled && (
        <div className="mt-2 text-[11px] text-muted-foreground">
          Requires the admin role and the registered master wallet connected.
        </div>
      )}
    </div>
  );
}
