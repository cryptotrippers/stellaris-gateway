import { useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, PenLine, Send, TrendingUp } from "lucide-react";
import { cardanoscanTx, formatSharePrice, lovelaceToAda, short } from "@/lib/chain-format";
import { buildAccrual, coSignAccrual, submitAccrual, type AccrualDraft } from "@/lib/vault-accrual";
import { recordYieldAccrual } from "@/lib/yield-accruals.functions";
import type { AssetVaultRow } from "@/lib/asset-vaults.shared";

/**
 * Operator surface for moving a vault's share price: build the accrual, gather
 * M-of-N operator signatures, submit, then record the transaction only after
 * the server has re-verified it on chain.
 */
export function AccrueYieldCard({
  vaults,
  disabled,
  onDone,
}: {
  vaults: AssetVaultRow[];
  disabled: boolean;
  onDone: () => void;
}) {
  const [assetId, setAssetId] = useState("");
  const [amountAda, setAmountAda] = useState("");
  const [signersText, setSignersText] = useState("");
  const [draft, setDraft] = useState<AccrualDraft | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [recorded, setRecorded] = useState(false);
  const [busy, setBusy] = useState<null | "build" | "sign" | "submit">(null);
  const [error, setError] = useState<string | null>(null);

  const vault = vaults.find((v) => v.asset_id === assetId) ?? null;
  const extraSigners = signersText
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const reset = () => {
    setDraft(null);
    setTxHash(null);
    setRecorded(false);
    setError(null);
  };

  const build = async () => {
    setError(null);
    const ada = Number(amountAda);
    if (!vault) return setError("Select a vault first.");
    if (!(ada > 0)) return setError("Enter a positive ADA amount to accrue.");
    setBusy("build");
    try {
      const d = await buildAccrual({
        assetId: vault.asset_id,
        amountLovelace: BigInt(Math.round(ada * 1_000_000)),
        ...(extraSigners.length > 0 ? { signers: extraSigners } : {}),
      });
      setDraft(d);
      setTxHash(null);
      setRecorded(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const coSign = async () => {
    if (!draft) return;
    setError(null);
    setBusy("sign");
    try {
      setDraft(await coSignAccrual(draft));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const submit = async () => {
    if (!draft || !vault) return;
    setError(null);
    setBusy("submit");
    try {
      const hash = await submitAccrual(draft);
      setTxHash(hash);
      try {
        await recordYieldAccrual({
          data: {
            assetId: vault.asset_id,
            vaultVersion: vault.vault_version,
            address: vault.script_address,
            txHash: hash,
          },
        });
        setRecorded(true);
      } catch {
        // The transaction is on chain; the ledger is the source of truth. The
        // off-chain record can be retried once the tx is confirmed.
        setRecorded(false);
      }
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const record = async () => {
    if (!txHash || !vault) return;
    setError(null);
    setBusy("submit");
    try {
      await recordYieldAccrual({
        data: {
          assetId: vault.asset_id,
          vaultVersion: vault.vault_version,
          address: vault.script_address,
          txHash,
        },
      });
      setRecorded(true);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const signed = draft?.witnesses.length ?? 0;
  const needed = draft?.requiredSigners.length ?? 0;

  return (
    <section className="mt-10 card-institutional p-6">
      <h2 className="text-sm font-medium text-foreground">Accrue yield</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Adds real lovelace to the vault, advances its epoch and lifts the share price for every
        depositor. Share supply is untouched, and the validator requires the committee&apos;s
        threshold of signatures.
      </p>

      <div className="mt-5 grid gap-5 md:grid-cols-2">
        <label className="text-sm">
          <span className="text-muted-foreground">Vault</span>
          <select
            value={assetId}
            onChange={(e) => {
              setAssetId(e.target.value);
              reset();
            }}
            className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
          >
            <option value="">Select a bootstrapped vault…</option>
            {vaults.map((v) => (
              <option key={v.id} value={v.asset_id}>
                {v.asset_id} · {v.signature_threshold}-of-{v.operator_key_hashes.length}
              </option>
            ))}
          </select>
          {vaults.length === 0 && (
            <span className="mt-1 block text-[11px] text-muted-foreground">
              No vault ledger exists yet — bootstrap one first.
            </span>
          )}
        </label>

        <label className="text-sm">
          <span className="text-muted-foreground">Yield amount (ADA)</span>
          <input
            type="number"
            min={0}
            step="0.1"
            value={amountAda}
            onChange={(e) => {
              setAmountAda(e.target.value);
              reset();
            }}
            className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm tabular-nums"
            placeholder="e.g. 2.5"
          />
          <span className="mt-1 block text-[11px] text-muted-foreground">
            Paid from the connected operator wallet into the vault.
          </span>
        </label>
      </div>

      {vault && vault.signature_threshold > 1 && (
        <div className="mt-5">
          <span className="text-sm text-muted-foreground">
            Signing operators ({vault.signature_threshold} required)
          </span>
          <textarea
            value={signersText}
            onChange={(e) => setSignersText(e.target.value)}
            rows={3}
            placeholder="One operator key hash per line, including your own"
            className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-xs"
          />
        </div>
      )}

      {draft && (
        <div className="mt-5 rounded-md border border-border bg-secondary/20 p-4 text-xs">
          <div className="grid gap-3 sm:grid-cols-3">
            <Stat label="Epoch" value={`${draft.epochBefore} → ${draft.epochAfter}`} />
            <Stat
              label="Share price"
              value={`${formatSharePrice(draft.sharePriceBefore)} → ${formatSharePrice(draft.sharePriceAfter)}`}
            />
            <Stat
              label="Vault assets"
              value={`${lovelaceToAda(draft.totalAssetsBefore)} → ${lovelaceToAda(draft.totalAssetsAfter)} ₳`}
            />
          </div>
          <div className="mt-3 text-muted-foreground">
            Signatures {signed} of {needed}
            {draft.requiredSigners.length > 0 && (
              <span className="ml-2 font-mono">
                {draft.requiredSigners
                  .map(
                    (s) =>
                      `${short(s, 8, 4)}${draft.witnesses.some((w) => w.keyHash === s) ? " ✓" : " …"}`,
                  )
                  .join("  ")}
              </span>
            )}
          </div>
        </div>
      )}

      {error && (
        <div className="mt-4 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {txHash && (
        <div className="mt-4 flex items-start gap-2 rounded-md border border-success/40 bg-success/10 p-3 text-sm text-success">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Accrual submitted.{" "}
            <a href={cardanoscanTx(txHash)} target="_blank" rel="noreferrer" className="underline">
              View transaction
            </a>
            {recorded ? " — verified and recorded." : " — awaiting confirmation before recording."}
          </span>
        </div>
      )}

      <div className="mt-5 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={build}
          disabled={disabled || busy !== null || !assetId || !amountAda}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {busy === "build" ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <TrendingUp className="h-4 w-4" />
          )}
          Build accrual
        </button>

        {draft && signed < needed && (
          <button
            type="button"
            onClick={coSign}
            disabled={busy !== null}
            className="inline-flex items-center gap-2 rounded-md border border-border px-4 py-2 text-sm font-medium disabled:opacity-50"
          >
            {busy === "sign" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <PenLine className="h-4 w-4" />
            )}
            Co-sign with this wallet
          </button>
        )}

        {draft && !txHash && (
          <button
            type="button"
            onClick={submit}
            disabled={busy !== null || signed < needed}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            {busy === "submit" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
            Submit accrual
          </button>
        )}

        {txHash && !recorded && (
          <button
            type="button"
            onClick={record}
            disabled={busy !== null}
            className="inline-flex items-center gap-2 rounded-md border border-border px-4 py-2 text-sm font-medium disabled:opacity-50"
          >
            {busy === "submit" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <CheckCircle2 className="h-4 w-4" />
            )}
            Verify &amp; record
          </button>
        )}
      </div>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-muted-foreground">{label}</div>
      <div className="mt-0.5 font-mono text-foreground">{value}</div>
    </div>
  );
}
