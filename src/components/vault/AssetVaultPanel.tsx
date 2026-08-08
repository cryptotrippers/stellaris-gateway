import { useQuery } from "@tanstack/react-query";
import { ExternalLink, Landmark } from "lucide-react";
import { getAssetVault } from "@/lib/asset-vaults.functions";
import { getVaultChainState } from "@/lib/yield-chain.functions";
import {
  cardanoscanAddress,
  cardanoscanTx,
  formatSharePrice,
  lovelaceToAda,
  short,
} from "@/lib/chain-format";

/**
 * On-chain facts for one asset's vault: derived script address, current share
 * price, locked value and epoch. Every figure comes from the ledger; when the
 * vault is not bootstrapped the card says exactly that.
 */
export function AssetVaultPanel({ assetId }: { assetId: string }) {
  const vaultQ = useQuery({
    queryKey: ["asset-vault", assetId],
    queryFn: () => getAssetVault({ data: { assetId } }),
    staleTime: 60_000,
  });
  const vault = vaultQ.data ?? null;

  const stateQ = useQuery({
    queryKey: ["vault-chain-state", vault?.script_address],
    queryFn: () => getVaultChainState({ data: { address: vault!.script_address } }),
    enabled: !!vault?.script_address,
    refetchInterval: 60_000,
    retry: 0,
  });

  return (
    <div className="card-institutional p-6">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <Landmark className="h-4 w-4 text-primary" /> On-chain vault
      </h2>

      {vaultQ.isLoading && (
        <div className="mt-4 h-20 animate-pulse rounded-lg bg-secondary/40" />
      )}

      {!vaultQ.isLoading && !vault && (
        <p className="mt-3 text-sm text-muted-foreground">
          No vault has been bootstrapped for this asset yet. Deposits open once an
          operator derives the script and publishes the first State output.
        </p>
      )}

      {vault && (
        <>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <Row label="Network" value={vault.network} />
            <Row label="Vault version" value={`v${vault.vault_version}`} />
            <Row label="Script hash" value={short(vault.script_hash, 10, 6)} mono />
            <Row
              label="Committee"
              value={`${vault.signature_threshold}-of-${vault.operator_key_hashes.length}`}
            />
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
            <a
              href={cardanoscanAddress(vault.script_address)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 font-medium text-primary"
            >
              Vault address <ExternalLink className="h-3.5 w-3.5" />
            </a>
            {vault.bootstrap_tx_hash && (
              <a
                href={cardanoscanTx(vault.bootstrap_tx_hash)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 font-medium text-primary"
              >
                Bootstrap tx <ExternalLink className="h-3.5 w-3.5" />
              </a>
            )}
          </div>

          <div className="mt-5 border-t border-border/60 pt-4">
            {stateQ.isLoading && (
              <div className="h-16 animate-pulse rounded-lg bg-secondary/40" />
            )}
            {stateQ.error && (
              <p className="text-xs text-destructive">
                Could not read chain state right now.
              </p>
            )}
            {stateQ.data && !stateQ.data.found && (
              <p className="text-xs text-muted-foreground">
                No State output found at this address yet.
              </p>
            )}
            {stateQ.data?.found && stateQ.data.state && (
              <div className="grid grid-cols-3 gap-3 text-center">
                <Stat label="Share price" value={formatSharePrice(stateQ.data.sharePrice)} accent />
                <Stat label="Locked" value={`₳ ${lovelaceToAda(stateQ.data.lockedLovelace)}`} />
                <Stat label="Epoch" value={String(stateQ.data.state.epoch)} />
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Row({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between rounded-lg bg-secondary/40 px-3 py-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className={`font-medium text-foreground ${mono ? "font-mono text-xs" : ""}`}>{value}</span>
    </div>
  );
}

function Stat({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded-xl bg-secondary/50 py-2">
      <div className="text-[9.5px] uppercase tracking-widest text-muted-foreground">{label}</div>
      <div className={`number-display text-sm font-semibold ${accent ? "text-primary" : "text-foreground"}`}>
        {value}
      </div>
    </div>
  );
}
