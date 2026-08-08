import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  ExternalLink,
  Inbox,
  PauseCircle,
  Radio,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import { Badge } from "@/components/ui/StatusBadge";
import { getBlockfrostHealth, getPreprodTip } from "@/lib/blockfrost.functions";
import { listAssetVaults, type AssetVaultRow } from "@/lib/asset-vaults.functions";
import { getVaultChainHistory, getVaultChainState } from "@/lib/yield-chain.functions";
import { listVaultProposals } from "@/lib/governance-vault.functions";
import {
  cardanoscanAddress,
  cardanoscanTx,
  formatSharePrice,
  lovelaceToAda,
  short,
  timeAgo,
} from "@/lib/chain-format";

export const Route = createFileRoute("/yield")({
  head: () => ({
    meta: [
      { title: "Vault Yield Ledger · Stellaris Finance" },
      {
        name: "description",
        content:
          "Share price, epoch and every yield accrual for each Stellaris vault, read directly from the Cardano ledger. No estimates, no simulations.",
      },
      { property: "og:title", content: "Stellaris · Vault Yield Ledger" },
      {
        property: "og:description",
        content: "Every yield figure traced to the Cardano transaction that produced it.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: YieldLedger,
});

function YieldLedger() {
  const healthQ = useQuery({
    queryKey: ["preprod", "blockfrost-health"],
    queryFn: () => getBlockfrostHealth(),
    refetchInterval: 60_000,
    retry: 0,
  });

  const tipQ = useQuery({
    queryKey: ["preprod", "tip"],
    queryFn: () => getPreprodTip(),
    refetchInterval: 30_000,
    retry: 0,
    enabled: healthQ.data?.status === "ok",
  });

  const vaultsQ = useQuery({
    queryKey: ["asset-vaults"],
    queryFn: () => listAssetVaults(),
    staleTime: 60_000,
  });

  const proposalsQ = useQuery({
    queryKey: ["vault-proposals", "all"],
    queryFn: () => listVaultProposals({ data: {} }),
    staleTime: 60_000,
  });

  const tip = tipQ.data ?? null;
  const vaults = vaultsQ.data ?? [];
  const chainDown = healthQ.data && healthQ.data.status !== "ok";

  return (
    <AppShell>
      <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
        <div>
          <div className="text-[11px] uppercase tracking-[0.22em] text-primary">Yield ledger</div>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight text-foreground">
            Share price &amp; accruals, read from chain
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Every number here is decoded from a vault&apos;s state UTxO on Cardano Preprod. A vault
            with no accruals says so — nothing is projected, estimated, or filled in.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium ${
              tip
                ? "border-success/30 bg-success/10 text-success"
                : chainDown
                  ? "border-destructive/40 bg-destructive/10 text-destructive"
                  : "border-border bg-secondary/30 text-muted-foreground"
            }`}
          >
            <Radio className="h-3 w-3" />
            {tip
              ? `Preprod · epoch ${tip.epoch} · slot ${tip.epochSlot.toLocaleString()}`
              : chainDown
                ? "Chain indexer unavailable"
                : "Connecting…"}
          </span>
          <button
            type="button"
            onClick={() => {
              vaultsQ.refetch();
              tipQ.refetch();
            }}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-[11px] text-muted-foreground hover:text-foreground"
          >
            <RefreshCw className={`h-3 w-3 ${vaultsQ.isFetching ? "animate-spin" : ""}`} /> Refresh
          </button>
        </div>
      </div>

      {chainDown && (
        <div className="mt-6 flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>{healthQ.data?.detail}</div>
        </div>
      )}

      {vaultsQ.isLoading && (
        <div className="mt-6 card-institutional p-6 text-sm text-muted-foreground">
          Loading registered vaults…
        </div>
      )}

      {vaultsQ.error && (
        <div className="mt-6 card-institutional p-6 text-sm text-destructive">
          Failed to load vaults: {(vaultsQ.error as Error).message}
        </div>
      )}

      {vaultsQ.data && vaults.length === 0 && (
        <div className="mt-6 card-institutional flex flex-col items-start gap-3 p-8">
          <Inbox className="h-6 w-6 text-muted-foreground" />
          <div className="text-sm font-medium text-foreground">No vault has been bootstrapped yet</div>
          <p className="max-w-xl text-sm text-muted-foreground">
            A yield vault only exists once its ledger UTxO is created on chain. Until then there is
            no share price to report. Admins can create one from the operator console.
          </p>
          <Link
            to="/operators"
            className="rounded-md border border-border px-3 py-1.5 text-xs text-foreground hover:bg-secondary/40"
          >
            Open operator console
          </Link>
        </div>
      )}

      <div className="mt-6 flex flex-col gap-6">
        {vaults.map((vault) => (
          <VaultLedgerCard
            key={vault.id}
            vault={vault}
            proposals={(proposalsQ.data ?? []).filter((p) => p.asset_id === vault.asset_id)}
          />
        ))}
      </div>
    </AppShell>
  );
}

interface ProposalLite {
  id: string;
  sip_number: string;
  title: string;
  executed_tx_hash: string | null;
}

function VaultLedgerCard({
  vault,
  proposals,
}: {
  vault: AssetVaultRow;
  proposals: ProposalLite[];
}) {
  const stateQ = useQuery({
    queryKey: ["vault-state", vault.script_address],
    queryFn: () => getVaultChainState({ data: { address: vault.script_address } }),
    refetchInterval: 60_000,
    retry: 0,
  });

  const historyQ = useQuery({
    queryKey: ["vault-history", vault.script_address],
    queryFn: () => getVaultChainHistory({ data: { address: vault.script_address, max: 50 } }),
    staleTime: 60_000,
    retry: 0,
  });

  const state = stateQ.data;
  const history = historyQ.data;
  const accruals = [...(history?.accruals ?? [])].reverse();

  const proposalFor = (txHash: string) =>
    proposals.find((p) => p.executed_tx_hash?.toLowerCase() === txHash.toLowerCase()) ?? null;

  return (
    <section className="card-institutional overflow-hidden">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border p-5">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold text-foreground">{vault.asset_id}</h2>
            <Badge tone="accent">v{vault.vault_version}</Badge>
            {state?.state?.paused && (
              <Badge tone="warning">
                <PauseCircle className="h-3 w-3" /> paused
              </Badge>
            )}
          </div>
          <a
            href={cardanoscanAddress(vault.script_address)}
            target="_blank"
            rel="noreferrer"
            className="mt-1 inline-flex items-center gap-1 font-mono text-[11px] text-muted-foreground hover:text-primary"
          >
            {short(vault.script_address, 16, 10)} <ExternalLink className="h-3 w-3" />
          </a>
        </div>
        <div className="text-right text-[11px] text-muted-foreground">
          <div>
            {vault.signature_threshold}-of-{vault.operator_key_hashes.length} operator signatures
          </div>
          {vault.bootstrap_tx_hash && (
            <a
              href={cardanoscanTx(vault.bootstrap_tx_hash)}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 font-mono hover:text-primary"
            >
              bootstrap {short(vault.bootstrap_tx_hash, 6, 4)} <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
      </header>

      {stateQ.isLoading && (
        <div className="p-5 text-sm text-muted-foreground">Reading vault state from chain…</div>
      )}

      {stateQ.error && (
        <div className="p-5 text-sm text-destructive">
          Could not read this vault: {(stateQ.error as Error).message}
        </div>
      )}

      {state && !state.found && (
        <div className="flex items-start gap-3 p-5 text-sm text-muted-foreground">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <div>
            No state UTxO found at this address. The vault is registered but its on-chain ledger has
            not been created yet, so it has no share price and cannot accept deposits.
          </div>
        </div>
      )}

      {state?.found && state.state && (
        <>
          <div className="grid grid-cols-2 gap-px bg-border md:grid-cols-5">
            <Metric label="Share price" value={formatSharePrice(state.sharePrice)} />
            <Metric label="Epoch" value={String(state.state.epoch)} />
            <Metric label="Total assets" value={`${lovelaceToAda(state.state.totalAssets)} ADA`} />
            <Metric label="Shares issued" value={Number(state.state.totalShares).toLocaleString()} />
            <Metric
              label="Annualised"
              value={
                history?.apyPct !== null && history?.apyPct !== undefined
                  ? `${history.apyPct.toFixed(2)}%`
                  : "—"
              }
              hint={
                history?.apyPct === null || history?.apyPct === undefined
                  ? "needs 2 accruals"
                  : "from real accruals"
              }
            />
          </div>

          <div className="border-t border-border p-5">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-medium text-foreground">Accrual history</h3>
              <span className="text-[11px] text-muted-foreground">
                {state.positions.length} open position{state.positions.length === 1 ? "" : "s"} ·{" "}
                {lovelaceToAda(state.lockedLovelace)} ADA locked
              </span>
            </div>

            {historyQ.isLoading && (
              <div className="text-sm text-muted-foreground">Scanning vault transactions…</div>
            )}

            {history && accruals.length === 0 && (
              <div className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
                No accruals yet — share price {formatSharePrice(state.sharePrice)}. Yield appears
                here only after operators execute an approved accrual on chain.
              </div>
            )}

            {accruals.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-border text-[11px] uppercase tracking-wider text-muted-foreground">
                      <th className="py-2 pr-4 font-medium">Epoch</th>
                      <th className="py-2 pr-4 font-medium">Accrued</th>
                      <th className="py-2 pr-4 font-medium">Share price</th>
                      <th className="py-2 pr-4 font-medium">Authorised by</th>
                      <th className="py-2 pr-4 font-medium">When</th>
                      <th className="py-2 font-medium">Transaction</th>
                    </tr>
                  </thead>
                  <tbody>
                    {accruals.map((a) => {
                      const proposal = proposalFor(a.txHash);
                      return (
                        <tr key={a.txHash} className="border-b border-border/50 last:border-0">
                          <td className="py-2 pr-4 tabular-nums">{a.epoch}</td>
                          <td className="py-2 pr-4 tabular-nums text-success">
                            +{lovelaceToAda(a.amountLovelace)} ADA
                          </td>
                          <td className="py-2 pr-4 font-mono text-xs">
                            {formatSharePrice(a.sharePriceBefore)} →{" "}
                            <span className="text-foreground">
                              {formatSharePrice(a.sharePriceAfter)}
                            </span>
                          </td>
                          <td className="py-2 pr-4 text-xs">
                            {proposal ? (
                              <Link
                                to="/governance"
                                className="text-primary hover:underline"
                              >
                                {proposal.sip_number}
                              </Link>
                            ) : (
                              <span className="text-muted-foreground">unlinked</span>
                            )}
                          </td>
                          <td className="py-2 pr-4 text-xs text-muted-foreground">
                            {timeAgo(a.blockTime * 1000)}
                          </td>
                          <td className="py-2">
                            <a
                              href={cardanoscanTx(a.txHash)}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground hover:text-primary"
                            >
                              {short(a.txHash)} <ExternalLink className="h-3 w-3" />
                            </a>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {history?.truncated && (
              <p className="mt-3 text-[11px] text-muted-foreground">
                Showing the most recent {history.scanned} transactions at this address.
              </p>
            )}
          </div>
        </>
      )}

      <footer className="flex items-center gap-2 border-t border-border bg-secondary/20 px-5 py-2 text-[11px] text-muted-foreground">
        <ShieldCheck className="h-3 w-3" /> Decoded from the vault state UTxO. Verify any figure by
        opening its transaction.
      </footer>
    </section>
  );
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="bg-card p-4">
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums text-foreground">{value}</div>
      {hint && <div className="text-[10px] text-muted-foreground">{hint}</div>}
    </div>
  );
}
