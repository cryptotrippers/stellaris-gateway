import { useEffect, useState } from "react";
import { formatFeeBps } from "@/lib/vault-fees";
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardCopy,
  Link2,
  Loader2,
  PenLine,
  Send,
  TrendingUp,
  Users,
} from "lucide-react";
import { cardanoscanTx, formatSharePrice, lovelaceToAda, short } from "@/lib/chain-format";
import { buildAccrual, coSignAccrual, submitAccrual, type AccrualDraft } from "@/lib/vault-accrual";
import {
  addWitnessToDraft,
  decodeDraft,
  draftShareLink,
  encodeDraft,
  mergeDrafts,
  readDraftFromLocation,
} from "@/lib/accrual-share";
import { recordYieldAccrual } from "@/lib/yield-accruals.functions";
import type { AssetVaultRow } from "@/lib/asset-vaults.shared";

/**
 * Operator surface for moving a vault's share price: build the accrual, gather
 * M-of-N operator signatures — in person, by pasted witness, or over a shared
 * link — submit, then record it only after the server re-verifies it on chain.
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
  const [importText, setImportText] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  // A co-signer arriving from a shared link starts with the draft already loaded.
  useEffect(() => {
    const shared = readDraftFromLocation();
    if (!shared) return;
    setDraft(shared);
    setAssetId(shared.assetId);
    setAmountAda((Number(shared.amountLovelace) / 1_000_000).toString());
    setNotice("Loaded a shared accrual draft from the link. Co-sign it with your wallet below.");
  }, []);

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
    setNotice(null);
  };

  const copy = async (text: string, message: string) => {
    setError(null);
    try {
      await navigator.clipboard.writeText(text);
      setNotice(message);
    } catch {
      setError("Couldn't reach the clipboard — select the text and copy it manually.");
    }
  };

  /** Accepts either a full draft blob or a bare witness hex string. */
  const importSignature = () => {
    setError(null);
    setNotice(null);
    const value = importText.trim().replace(/\s+/g, "");
    if (!value) return setError("Paste a witness or a draft first.");
    try {
      if (/^[0-9a-f]+$/i.test(value)) {
        if (!draft) throw new Error("Build or load a draft before pasting a witness.");
        const next = addWitnessToDraft(draft, value);
        setDraft(next);
        setNotice(
          `Added a signature from ${short(next.witnesses[next.witnesses.length - 1]!.keyHash, 8, 4)}.`,
        );
      } else {
        const incoming = decodeDraft(value);
        const next = draft ? mergeDrafts(draft, incoming) : incoming;
        setDraft(next);
        setAssetId(next.assetId);
        setNotice(`Draft loaded — ${next.witnesses.length} of ${next.requiredSigners.length} signed.`);
      }
      setImportText("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
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
        registryAddress: vault.script_address,
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
          <div className="mt-3 grid gap-3 border-t border-border pt-3 sm:grid-cols-3">
            <Stat label="Management fee" value={formatFeeBps(draft.feeBps)} />
            <Stat label="Fee settled" value={`${lovelaceToAda(draft.feeAssets)} ₳`} />
            <Stat
              label="Treasury shares minted"
              value={draft.feeSharesMinted}
            />
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">
            The fee accrued up to {new Date(draft.settledAt).toLocaleString()} is settled first, by
            minting shares to the treasury. No lovelace leaves the vault; depositors are diluted by
            exactly the fee owed.
          </p>

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

      {draft && !txHash && (
        <div className="mt-5 rounded-md border border-border p-4">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Users className="h-4 w-4 text-primary" />
            Signature collection
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Co-signers can sign here with their own wallet, open a shared link, or send back just
            their witness. A witness is only counted once its public key matches an operator this
            transaction requires.
          </p>

          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => copy(draftShareLink(draft), "Share link copied — send it to a co-signer.")}
              className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-xs font-medium"
            >
              <Link2 className="h-3.5 w-3.5" /> Copy share link
            </button>
            <button
              type="button"
              onClick={() => copy(encodeDraft(draft), "Draft copied to the clipboard.")}
              className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-xs font-medium"
            >
              <ClipboardCopy className="h-3.5 w-3.5" /> Copy draft
            </button>
            {draft.witnesses.length > 0 && (
              <button
                type="button"
                onClick={() =>
                  copy(
                    draft.witnesses[draft.witnesses.length - 1]!.witness,
                    "Your witness copied — send it back to the coordinator.",
                  )
                }
                className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-xs font-medium"
              >
                <ClipboardCopy className="h-3.5 w-3.5" /> Copy my witness
              </button>
            )}
          </div>

          <label className="mt-4 block text-xs">
            <span className="text-muted-foreground">Paste a witness or a shared draft</span>
            <textarea
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              rows={3}
              placeholder="Witness CBOR hex, or an encoded draft from another operator"
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-[11px]"
            />
          </label>
          <button
            type="button"
            onClick={importSignature}
            disabled={!importText.trim()}
            className="mt-2 inline-flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-xs font-medium disabled:opacity-50"
          >
            <PenLine className="h-3.5 w-3.5" /> Add signature
          </button>
        </div>
      )}

      {notice && (
        <div className="mt-4 rounded-md border border-primary/40 bg-primary/10 p-3 text-sm text-foreground">
          {notice}
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
