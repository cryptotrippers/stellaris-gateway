import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, ExternalLink, Loader2, PenLine, Send } from "lucide-react";
import { cardanoscanTx, lovelaceToAda, short } from "@/lib/chain-format";
import { formatFeeBps } from "@/lib/vault-fees";
import { buildSetFee, coSignSetFee, submitSetFee, type SetFeeDraft } from "@/lib/vault-set-fee";
import { getAssetVault } from "@/lib/asset-vaults.functions";
import { recordProposalExecution } from "@/lib/governance-vault.functions";
import type { ProposalRow } from "@/lib/governance-vault.shared";

/**
 * Executing a fee change is a real Cardano transaction. The operator builds a
 * `SetFee` spend of the vault's state UTxO, collects the committee's
 * signatures, submits it, and only then does the server verify it on chain and
 * store the hash as proof against the proposal.
 */
export function SetFeeExecuteCard({
  proposal,
  onExecuted,
}: {
  proposal: ProposalRow;
  onExecuted: () => void;
}) {
  const [draft, setDraft] = useState<SetFeeDraft | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [recorded, setRecorded] = useState(false);
  const [busy, setBusy] = useState<null | "build" | "sign" | "submit" | "record">(null);
  const [error, setError] = useState<string | null>(null);

  const feeBps = Number(proposal.params?.["fee_bps"] ?? NaN);
  const assetId = proposal.asset_id ?? "";

  const vaultQ = useQuery({
    queryKey: ["asset-vault", assetId],
    queryFn: () => getAssetVault({ data: { assetId } }),
    enabled: Boolean(assetId),
    staleTime: 60_000,
  });
  const vault = vaultQ.data ?? null;

  const run = async (stage: "build" | "sign" | "submit" | "record", fn: () => Promise<void>) => {
    setBusy(stage);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const build = () =>
    run("build", async () => {
      const d = await buildSetFee({
        assetId,
        feeBps,
        registryAddress: vault?.script_address ?? null,
      });
      setDraft(d);
    });

  const coSign = () =>
    run("sign", async () => {
      if (!draft) return;
      setDraft(await coSignSetFee(draft));
    });

  const submit = () =>
    run("submit", async () => {
      if (!draft) return;
      setTxHash(await submitSetFee(draft));
    });

  const record = () =>
    run("record", async () => {
      if (!txHash) return;
      const res = await recordProposalExecution({ data: { proposalId: proposal.id, txHash } });
      if (!res.ok) {
        setError(res.reason);
        return;
      }
      setRecorded(true);
      onExecuted();
    });

  if (!Number.isInteger(feeBps) || !assetId) {
    return (
      <p className="mt-2 text-xs text-destructive">
        This fee proposal is missing the asset or the approved rate, so it cannot be executed.
      </p>
    );
  }

  const signaturesNeeded = draft ? draft.requiredSigners.length - draft.witnesses.length : 0;

  return (
    <div className="mt-2 space-y-3 text-xs">
      <p className="text-muted-foreground">
        Executing this proposal signs a fee change into the vault itself. The fee owed under the old
        rate is settled in the same transaction, so the new rate can never apply retroactively.
      </p>

      <div className="rounded-lg border border-border bg-muted/30 p-3">
        <Row label="Asset" value={assetId} />
        <Row label="Approved fee" value={formatFeeBps(feeBps)} />
        <Row
          label="Vault address"
          value={vault?.script_address ? short(vault.script_address) : "Not registered"}
        />
      </div>

      {!vault && !vaultQ.isLoading && (
        <p className="text-destructive">
          No bootstrapped vault is registered for this asset, so there is nothing to change on chain
          yet.
        </p>
      )}

      {!draft && vault && (
        <button
          type="button"
          onClick={build}
          disabled={busy !== null}
          className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {busy === "build" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <PenLine className="h-3.5 w-3.5" />
          )}
          Build &amp; sign fee change
        </button>
      )}

      {draft && (
        <div className="space-y-3 rounded-lg border border-border p-3">
          <Row label="Fee before" value={formatFeeBps(draft.feeBpsBefore)} />
          <Row label="Fee after" value={formatFeeBps(draft.feeBpsAfter)} />
          <Row label="Fee settled now" value={`${lovelaceToAda(draft.feeAssets)} ₳`} />
          <Row label="Treasury shares minted" value={draft.feeSharesMinted} />
          <Row
            label="Signatures"
            value={`${draft.witnesses.length} of ${draft.requiredSigners.length}`}
          />

          {!txHash && signaturesNeeded > 0 && (
            <button
              type="button"
              onClick={coSign}
              disabled={busy !== null}
              className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
            >
              {busy === "sign" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <PenLine className="h-3.5 w-3.5" />
              )}
              Co-sign with this wallet
            </button>
          )}

          {!txHash && signaturesNeeded === 0 && (
            <button
              type="button"
              onClick={submit}
              disabled={busy !== null}
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {busy === "submit" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Send className="h-3.5 w-3.5" />
              )}
              Submit to Preprod
            </button>
          )}
        </div>
      )}

      {txHash && (
        <div className="space-y-2 rounded-lg border border-border p-3">
          <a
            href={cardanoscanTx(txHash)}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 font-mono text-primary hover:underline"
          >
            {short(txHash)}
            <ExternalLink className="h-3 w-3" />
          </a>
          {recorded ? (
            <p className="inline-flex items-center gap-1 text-success">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Verified on chain and recorded against this proposal.
            </p>
          ) : (
            <button
              type="button"
              onClick={record}
              disabled={busy !== null}
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {busy === "record" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Verify &amp; record execution
            </button>
          )}
          {!recorded && (
            <p className="text-muted-foreground">
              Wait for the transaction to reach a block, then record it — verification reads the
              vault&apos;s state from the chain.
            </p>
          )}
        </div>
      )}

      {error && <p className="text-destructive">{error}</p>}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-mono text-foreground">{value}</span>
    </div>
  );
}
