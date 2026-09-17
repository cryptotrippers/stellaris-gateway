import { useState } from "react";
import { AlertTriangle, Banknote, CheckCircle2, Loader2, PenLine, Send } from "lucide-react";
import { cardanoscanTx, lovelaceToAda, short } from "@/lib/chain-format";
import {
  buildTreasuryClaim,
  coSignTreasuryClaim,
  submitTreasuryClaim,
  type TreasuryClaimDraft,
} from "@/lib/treasury-claim";
import type { AssetVaultRow } from "@/lib/asset-vaults.shared";

/**
 * Operator surface for cashing out a vault's accrued revenue. Burns treasury
 * shares and pays their redeemable value to the treasury key written into the
 * vault's datum — the validator allows no other destination, and requires the
 * committee's threshold of signatures.
 */
export function ClaimTreasuryCard({
  vaults,
  disabled,
}: {
  vaults: AssetVaultRow[];
  disabled: boolean;
}) {
  const [assetId, setAssetId] = useState("");
  const [sharesText, setSharesText] = useState("");
  const [signersText, setSignersText] = useState("");
  const [draft, setDraft] = useState<TreasuryClaimDraft | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
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
    setError(null);
  };

  const run = async (stage: "build" | "sign" | "submit", fn: () => Promise<void>) => {
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
      if (!vault) throw new Error("Select a vault first.");
      const shares = sharesText.trim() ? BigInt(sharesText.trim()) : undefined;
      const d = await buildTreasuryClaim({
        assetId: vault.asset_id,
        registryAddress: vault.script_address,
        ...(shares === undefined ? {} : { shares }),
        ...(extraSigners.length > 0 ? { signers: extraSigners } : {}),
      });
      setDraft(d);
      setTxHash(null);
    });

  const coSign = () =>
    run("sign", async () => {
      if (!draft) return;
      setDraft(await coSignTreasuryClaim(draft));
    });

  const submit = () =>
    run("submit", async () => {
      if (!draft) return;
      setTxHash(await submitTreasuryClaim(draft));
    });

  const signed = draft?.witnesses.length ?? 0;
  const needed = draft?.requiredSigners.length ?? 0;

  return (
    <section className="mt-10 card-institutional p-6">
      <h2 className="text-sm font-medium text-foreground">Claim treasury revenue</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Cashes out fee shares the vault has accrued — management fee settled at each accrual, plus
        any deposit and withdrawal fees collected. Payment can only go to the treasury address in
        the vault&apos;s own state, and the committee&apos;s threshold must sign.
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
        </label>

        <label className="text-sm">
          <span className="text-muted-foreground">Treasury shares to claim</span>
          <input
            value={sharesText}
            onChange={(e) => {
              setSharesText(e.target.value);
              reset();
            }}
            inputMode="numeric"
            placeholder="Blank = all unclaimed fee shares"
            className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm tabular-nums"
          />
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
            <Stat label="Shares claimed" value={draft.sharesClaimed} />
            <Stat label="Paid out" value={`${lovelaceToAda(draft.paidLovelace)} ₳`} />
            <Stat
              label="Treasury shares"
              value={`${draft.treasurySharesBefore} → ${draft.treasurySharesAfter}`}
            />
          </div>
          <p className="mt-3 text-[11px] text-muted-foreground">
            Paying to treasury address{" "}
            <span className="font-mono text-foreground">{short(draft.treasuryAddress)}</span>.
            Signatures {signed} of {needed}.
          </p>
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
            Claim submitted.{" "}
            <a href={cardanoscanTx(txHash)} target="_blank" rel="noreferrer" className="underline">
              View transaction
            </a>
          </span>
        </div>
      )}

      <div className="mt-5 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={build}
          disabled={disabled || busy !== null || !assetId}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {busy === "build" ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Banknote className="h-4 w-4" />
          )}
          Build claim
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
            Submit claim
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
