import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/StatusBadge";
import { getVaultChainState } from "@/lib/yield-chain.functions";
import { getTxChainTimes } from "@/lib/governance-chain.functions";
import type { AssetVaultRow } from "@/lib/asset-vaults.functions";
import type { ProposalRow } from "@/lib/governance-vault.shared";
import { derivedStatus, DERIVED_STATUS_LABEL } from "@/lib/governance-votes.shared";
import { cardanoscanAddress, cardanoscanTx, formatSharePrice, lovelaceToAda, short } from "@/lib/chain-format";

/**
 * One registered vault, with its live on-chain state and the proposals that
 * govern it. Everything shown is either read from chain or explicitly marked
 * as not yet reported.
 */
export function VaultGovernanceCard({
  vault,
  proposals,
}: {
  vault: AssetVaultRow;
  proposals: ProposalRow[];
}) {
  const stateQ = useQuery({
    queryKey: ["governance", "vault-state", vault.script_address],
    queryFn: () => getVaultChainState({ data: { address: vault.script_address } }),
    staleTime: 30_000,
  });

  const bootstrapQ = useQuery({
    queryKey: ["governance", "vault-bootstrap-time", vault.bootstrap_tx_hash],
    queryFn: () => getTxChainTimes({ data: { txHashes: [vault.bootstrap_tx_hash!] } }),
    enabled: Boolean(vault.bootstrap_tx_hash),
    staleTime: 5 * 60_000,
  });
  const bootstrap = bootstrapQ.data?.[0];

  const state = stateQ.data;
  const linked = proposals.filter((p) => p.asset_id === vault.asset_id);

  return (
    <div className="card-institutional p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold text-foreground">{vault.asset_id}</h2>
            <Badge tone="accent">{vault.network}</Badge>
            <Badge tone="primary">v{vault.vault_version}</Badge>
          </div>
          <a
            href={cardanoscanAddress(vault.script_address)}
            target="_blank"
            rel="noreferrer"
            className="mt-2 inline-flex items-center gap-1.5 break-all font-mono text-xs text-muted-foreground hover:text-primary"
          >
            {vault.script_address} <ExternalLink className="h-3 w-3 shrink-0" />
          </a>
        </div>
        <div className="text-right text-xs text-muted-foreground">
          <div>
            {vault.signature_threshold}-of-{vault.operator_key_hashes.length} committee
          </div>
          <div className="mt-1">Reporting: {vault.reporting_cadence ?? "not set"}</div>
        </div>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-4">
        <Fact
          label="Total assets"
          value={
            stateQ.isLoading ? "Reading chain…"
            : state?.found && state.state ? `${lovelaceToAda(state.state.totalAssets)} ADA`
            : "State UTxO not found"
          }
        />
        <Fact
          label="Share price"
          value={
            stateQ.isLoading ? "Reading chain…"
            : state?.found ? formatSharePrice(state.sharePrice)
            : "—"
          }
        />
        <Fact
          label="Epoch"
          value={
            stateQ.isLoading ? "Reading chain…"
            : state?.found && state.state ? String(state.state.epoch)
            : "—"
          }
        />
        <Fact
          label="Vault paused"
          value={
            stateQ.isLoading ? "Reading chain…"
            : state?.found && state.state ? (state.state.paused ? "Yes" : "No")
            : "—"
          }
        />
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <Fact
          label="Bootstrap transaction"
          value={
            !vault.bootstrap_tx_hash ? "Not recorded"
            : bootstrapQ.isLoading ? "Reading block time…"
            : bootstrap?.found ?
              `${new Date(bootstrap.blockTime!).toLocaleDateString()}${bootstrap.epoch !== null ? ` · epoch ${bootstrap.epoch}` : ""}`
            : "Not found on chain"
          }
          href={vault.bootstrap_tx_hash ? cardanoscanTx(vault.bootstrap_tx_hash) : undefined}
          hint={vault.bootstrap_tx_hash ? short(vault.bootstrap_tx_hash) : undefined}
        />
        <Fact label="Independent valuation" value="Not attested" />
        <Fact label="Liquidity coverage" value="Not reported" />
      </div>

      <div className="mt-4 rounded-lg border border-border p-3">
        <div className="flex items-center justify-between">
          <div className="text-[10px] uppercase tracking-widest text-muted-foreground">
            Governance for this vault
          </div>
          <Link to="/governance" search={{ tab: "proposals" }} className="text-[11px] text-primary hover:underline">
            All proposals
          </Link>
        </div>
        {linked.length === 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">
            No proposals reference this vault yet. Accruals, pauses and committee changes must be
            proposed before an operator can execute them.
          </p>
        ) : (
          <ul className="mt-2 space-y-1.5">
            {linked.slice(0, 6).map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <span className="min-w-0 truncate text-foreground">
                  <span className="font-mono text-muted-foreground">{p.sip_number}</span> {p.title}
                </span>
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {DERIVED_STATUS_LABEL[derivedStatus(p)]}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Fact({
  label,
  value,
  href,
  hint,
}: {
  label: string;
  value: string;
  href?: string;
  hint?: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-secondary/20 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-1 text-xs font-medium text-foreground">{value}</div>
      {href && hint && (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="mt-0.5 inline-flex items-center gap-1 font-mono text-[10px] text-primary hover:underline"
        >
          {hint} <ExternalLink className="h-2.5 w-2.5" />
        </a>
      )}
    </div>
  );
}
