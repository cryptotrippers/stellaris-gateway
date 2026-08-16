import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Loader2, TrendingUp } from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import { Badge } from "@/components/ui/StatusBadge";
import { SusdrVaultActionsCard } from "@/components/vault/SusdrVaultActionsCard";
import { SusdrOperatorConsole } from "@/components/operators/SusdrOperatorConsole";
import { getMySusdrRoles, getSusdrVault, listSusdrAccruals } from "@/lib/susdr-vaults.functions";
import { annualisedReturnPct, deriveAccruals } from "@/lib/susdr-chain-decode";
import { cardanoscanTx, short } from "@/lib/chain-format";
import { USDR_POLICY_ID_PLACEHOLDER } from "@/lib/susdr-params";

export const Route = createFileRoute("/susdr")({
  head: () => ({
    meta: [
      { title: "sUSDr Vault · RealFi" },
      {
        name: "description",
        content:
          "Deposit USDr, hold sUSDr shares whose price rises as real yield is accrued on-chain. Preprod only.",
      },
    ],
  }),
  validateSearch: (search: Record<string, unknown>): { usdr?: string } => {
    const usdr = typeof search.usdr === "string" && /^[0-9a-f]{56}$/.test(search.usdr) ? search.usdr : undefined;
    return usdr ? { usdr } : {};
  },
  component: SusdrVaultPage,
});

function SusdrVaultPage() {
  const search = Route.useSearch();
  // No real USDr policy has been minted yet (see susdr-params.ts) — a real
  // deployment passes ?usdr=<policyId> once one exists, or an admin registers
  // it below. The placeholder lets this page render honestly ("not
  // bootstrapped yet") rather than crashing on an empty vault registry.
  const usdrPolicyId = search.usdr ?? USDR_POLICY_ID_PLACEHOLDER;

  const vaultQ = useQuery({
    queryKey: ["susdr-vault-registry-detail", usdrPolicyId],
    queryFn: () => getSusdrVault({ data: { usdrPolicyId } }),
  });
  const vault = vaultQ.data ?? null;

  const accrualsQ = useQuery({
    queryKey: ["susdr-accruals", usdrPolicyId],
    queryFn: () => listSusdrAccruals({ data: { usdrPolicyId } }),
    enabled: vault !== null,
  });

  const rolesQ = useQuery({
    queryKey: ["susdr-my-roles"],
    queryFn: () => getMySusdrRoles(),
    retry: 0,
  });
  const isOperator = (rolesQ.data?.roles ?? []).some((r) => r === "operator" || r === "admin");

  const accruals = accrualsQ.data ?? [];
  const chainAccruals = deriveAccruals(
    [...accruals].reverse().map((a) => ({
      tx: { tx_hash: a.tx_hash, block_height: a.block_height ?? 0, block_time: Math.floor(new Date(a.block_time).getTime() / 1000) },
      state: {
        totalShares: a.total_shares_after,
        totalAssets: a.total_assets_after,
        epoch: a.epoch,
        operators: [],
        threshold: 1,
        paused: false,
        feeBps: 0,
        treasury: "",
        treasuryShares: "0",
        lastFeeTime: "0",
      },
    })),
  );
  const apy = annualisedReturnPct(chainAccruals);

  return (
    <AppShell>
      <div className="mx-auto max-w-5xl px-4 py-10">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-[10px] uppercase tracking-widest text-primary">RealFi · Preprod only</div>
            <h1 className="mt-1 text-2xl font-semibold text-foreground">sUSDr vault</h1>
            <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
              Lock USDr, receive sUSDr shares. Share price rises only when operators accrue REAL,
              on-chain yield — see{" "}
              <a
                href="https://github.com/cryptotrippers/stellaris-gateway/blob/main/contracts/susdr-vault/DESIGN.md"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                DESIGN.md
              </a>{" "}
              for the full contract spec.
            </p>
          </div>
          {isOperator && <Badge tone="success">Operator</Badge>}
        </div>

        {vaultQ.isLoading ? (
          <p className="mt-8 flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading vault registry…
          </p>
        ) : !vault ? (
          <div className="mt-8 flex items-start gap-3 rounded-lg border border-warning/30 bg-warning/5 p-4 text-sm text-warning">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              No sUSDr vault is registered for USDr policy{" "}
              <span className="font-mono">{short(usdrPolicyId, 10, 6)}</span> yet. No real USDr has
              been minted in this build — this page is showing an honest empty state, not a
              placeholder number. An admin can mint a test USDr batch (
              <span className="font-mono">src/lib/usdr-mint.ts</span>), bootstrap a vault (
              <span className="font-mono">src/lib/susdr-bootstrap.ts</span>), and register it via{" "}
              <span className="font-mono">registerSusdrVault</span>.
            </div>
          </div>
        ) : (
          <>
            <div className="mt-8 grid gap-4 sm:grid-cols-4">
              <DetailStat label="Epoch" value={String(vault ? "—" : "—")} />
              <DetailStat
                label="Committee"
                value={`${vault.signature_threshold}-of-${vault.operator_key_hashes.length}`}
              />
              <DetailStat label="Management fee" value={`${(vault.fee_bps / 100).toFixed(2)}%/yr`} />
              <DetailStat
                label="APY (observed)"
                value={apy === null ? "Not enough history" : `${apy.toFixed(2)}%`}
                icon={<TrendingUp className="h-3 w-3" />}
              />
            </div>

            <div className="mt-4 rounded-lg border border-border bg-secondary/10 p-3 text-[11px] text-muted-foreground">
              Bootstrap tx:{" "}
              {vault.bootstrap_tx_hash ? (
                <a
                  href={cardanoscanTx(vault.bootstrap_tx_hash)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  {short(vault.bootstrap_tx_hash, 10, 6)}
                </a>
              ) : (
                "not recorded"
              )}{" "}
              · Address: <span className="font-mono">{short(vault.script_address, 14, 8)}</span> ·
              sUSDr policy: <span className="font-mono">{short(vault.susdr_policy_id, 10, 6)}</span>
            </div>

            <div className="mt-8 grid gap-6 lg:grid-cols-2">
              <SusdrVaultActionsCard usdrPolicyId={usdrPolicyId} />
              {isOperator && (
                <SusdrOperatorConsole
                  vault={vault}
                  disabled={false}
                  onDone={() => void accrualsQ.refetch()}
                />
              )}
            </div>

            {accruals.length > 0 && (
              <div className="mt-8">
                <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                  Accrual history
                </h2>
                <div className="mt-3 space-y-2">
                  {accruals.map((a) => (
                    <div
                      key={a.id}
                      className="flex items-center justify-between rounded-lg border border-border bg-surface px-4 py-2 text-xs"
                    >
                      <span>Epoch {a.epoch}</span>
                      <span className="tabular-nums text-muted-foreground">
                        +{(Number(a.amount_usdr) / 1e6).toFixed(2)} USDr
                      </span>
                      <a
                        href={cardanoscanTx(a.tx_hash)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary hover:underline"
                      >
                        {short(a.tx_hash, 8, 4)}
                      </a>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </AppShell>
  );
}

function DetailStat({
  label,
  value,
  icon,
}: {
  label: string;
  value: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border bg-surface px-4 py-3">
      <div className="flex items-center gap-1 text-[10px] uppercase tracking-widest text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className="mt-1 text-sm font-semibold text-foreground tabular-nums">{value}</div>
    </div>
  );
}
