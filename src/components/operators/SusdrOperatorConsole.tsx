import { useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, PenLine, Send, Users } from "lucide-react";
import { cardanoscanTx, short } from "@/lib/chain-format";
import { formatFeeBps } from "@/lib/vault-fees";
import {
  buildAccrue,
  buildSetFee,
  buildSetPaused,
  coSignGovernance,
  submitGovernance,
  type GovernanceDraft,
} from "@/lib/susdr-governance";
import { recordSusdrAccrual } from "@/lib/susdr-vaults.functions";
import type { SusdrVaultRow } from "@/lib/susdr-vaults.shared";

type Action = "accrue" | "pause" | "unpause" | "set-fee";

/**
 * Operator surface for the three actions Phase 3 asks for: Accrue, SetFee,
 * pause/unpause. Mirrors `AccrueYieldCard.tsx`'s build → co-sign → submit
 * flow, generalized across `susdr-governance.ts`'s draft/co-sign/submit
 * pattern instead of one Accrue-only builder.
 *
 * Unlike AccrueYieldCard.tsx, this does not implement the shareable-draft-
 * link co-signing flow (`accrual-share.ts`) — co-signing here means a second
 * operator reconnecting their own wallet in the SAME browser session and
 * clicking "Co-sign". A cross-device link flow is straightforward to add
 * later by extending `accrual-share.ts` (or a susdr-specific sibling) to
 * serialize a `GovernanceDraft`, but is out of scope for this build.
 */
export function SusdrOperatorConsole({
  vault,
  disabled,
  onDone,
}: {
  vault: SusdrVaultRow | null;
  disabled: boolean;
  onDone: () => void;
}) {
  const [action, setAction] = useState<Action>("accrue");
  const [amountUsdr, setAmountUsdr] = useState("");
  const [feeBps, setFeeBps] = useState("");
  const [signersText, setSignersText] = useState("");
  const [draft, setDraft] = useState<GovernanceDraft | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [recorded, setRecorded] = useState(false);
  const [busy, setBusy] = useState<null | "build" | "sign" | "submit">(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

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

  const build = async () => {
    setError(null);
    if (!vault) return setError("Select a vault first.");
    setBusy("build");
    try {
      const signers = extraSigners.length > 0 ? { signers: extraSigners } : {};
      let d: GovernanceDraft;
      if (action === "accrue") {
        const units = Number(amountUsdr);
        if (!(units > 0)) throw new Error("Enter a positive USDr amount to accrue.");
        d = await buildAccrue({
          usdrPolicyId: vault.usdr_policy_id,
          amountUsdr: BigInt(Math.round(units * 1_000_000)),
          registryAddress: vault.script_address,
          ...signers,
        });
      } else if (action === "set-fee") {
        const bps = Number(feeBps);
        if (!Number.isInteger(bps) || bps < 0 || bps > 500) {
          throw new Error("Fee must be a whole number of basis points between 0 and 500.");
        }
        d = await buildSetFee({
          usdrPolicyId: vault.usdr_policy_id,
          feeBps: bps,
          registryAddress: vault.script_address,
          ...signers,
        });
      } else {
        d = await buildSetPaused({
          usdrPolicyId: vault.usdr_policy_id,
          paused: action === "pause",
          registryAddress: vault.script_address,
          ...signers,
        });
      }
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
      setDraft(await coSignGovernance(draft));
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
      const hash = await submitGovernance(draft);
      setTxHash(hash);
      if (draft.action.kind === "Accrue") {
        try {
          await recordSusdrAccrual({
            data: {
              usdrPolicyId: vault.usdr_policy_id,
              txHash: hash,
              epoch: draft.stateAfter.epoch,
              amountUsdr: draft.action.amountUsdr,
              totalAssetsAfter: draft.stateAfter.totalAssets,
              totalSharesAfter: draft.stateAfter.totalShares,
              sharePriceBefore: sharePriceOf(draft.stateBefore),
              sharePriceAfter: sharePriceOf(draft.stateAfter),
              feeSharesMinted: (
                BigInt(draft.stateAfter.treasuryShares) - BigInt(draft.stateBefore.treasuryShares)
              ).toString(),
              blockTime: new Date().toISOString(),
            },
          });
          setRecorded(true);
        } catch (e) {
          // The on-chain tx already succeeded; recording is best-effort cache
          // maintenance, so surface but don't treat this as the action failing.
          setNotice(
            `Submitted on-chain, but recording it in the cache failed: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const signedCount = draft?.witnesses.length ?? 0;
  const neededCount = draft?.requiredSigners.length ?? 0;
  const fullySigned = draft !== null && signedCount >= neededCount;

  return (
    <div className="card-institutional p-6">
      <div className="flex items-center gap-2">
        <Users className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-semibold text-foreground">sUSDr operator console</h3>
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground">
        Accrue real yield, adjust the management fee, or pause/unpause the vault. Every action
        requires {vault?.signature_threshold ?? "M"}-of-{vault?.operator_key_hashes.length ?? "N"}{" "}
        operator signatures.
      </p>

      {!vault ? (
        <p className="mt-4 flex items-center gap-2 text-sm text-warning">
          <AlertTriangle className="h-3.5 w-3.5" /> No sUSDr vault selected.
        </p>
      ) : (
        <>
          <div className="mt-4 flex flex-wrap gap-2">
            {(["accrue", "set-fee", "pause", "unpause"] as Action[]).map((a) => (
              <button
                key={a}
                onClick={() => {
                  setAction(a);
                  reset();
                }}
                disabled={disabled || busy !== null}
                className={`rounded-full border px-3 py-1 text-xs font-medium ${
                  action === a
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border text-muted-foreground hover:text-foreground"
                }`}
              >
                {a === "accrue" ? "Accrue" : a === "set-fee" ? "Set fee" : a === "pause" ? "Pause" : "Unpause"}
              </button>
            ))}
          </div>

          {action === "accrue" && (
            <div className="mt-4 space-y-1">
              <label className="text-[11px] uppercase tracking-widest text-muted-foreground">
                USDr yield to accrue
              </label>
              <input
                value={amountUsdr}
                onChange={(e) => setAmountUsdr(e.target.value)}
                inputMode="decimal"
                placeholder="0.00"
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground"
              />
              <p className="text-[11px] text-muted-foreground">
                This must be REAL USDr that will actually land at the vault address in this same
                transaction — the validator checks the on-chain delta, not this number.
              </p>
            </div>
          )}

          {action === "set-fee" && (
            <div className="mt-4 space-y-1">
              <label className="text-[11px] uppercase tracking-widest text-muted-foreground">
                New annual fee (basis points, 0–500)
              </label>
              <input
                value={feeBps}
                onChange={(e) => setFeeBps(e.target.value)}
                inputMode="numeric"
                placeholder="100"
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground"
              />
              {feeBps && !Number.isNaN(Number(feeBps)) && (
                <p className="text-[11px] text-muted-foreground">= {formatFeeBps(Number(feeBps))}</p>
              )}
            </div>
          )}

          <div className="mt-4 space-y-1">
            <label className="text-[11px] uppercase tracking-widest text-muted-foreground">
              Additional co-signer key hashes (optional, comma or space separated)
            </label>
            <input
              value={signersText}
              onChange={(e) => setSignersText(e.target.value)}
              placeholder="pkh1, pkh2 …"
              className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-xs font-mono text-foreground"
            />
          </div>

          {!draft ? (
            <button
              onClick={() => void build()}
              disabled={disabled || busy !== null}
              className="mt-4 inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              {busy === "build" ? <Loader2 className="h-4 w-4 animate-spin" /> : <PenLine className="h-4 w-4" />}
              Build &amp; sign
            </button>
          ) : (
            <div className="mt-4 space-y-3 rounded-lg border border-border bg-secondary/10 p-4">
              <div className="text-xs text-muted-foreground">
                Signatures: <span className="tabular-nums text-foreground">{signedCount}</span> of{" "}
                <span className="tabular-nums text-foreground">{neededCount}</span> required
                {draft.requiredSigners
                  .filter((s) => !draft.witnesses.some((w) => w.keyHash === s))
                  .map((s) => (
                    <span key={s} className="ml-1 rounded bg-warning/10 px-1.5 py-0.5 text-warning">
                      {short(s, 6, 4)}
                    </span>
                  ))}
              </div>
              <div className="flex flex-wrap gap-2">
                {!fullySigned && (
                  <button
                    onClick={() => void coSign()}
                    disabled={busy !== null}
                    className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground disabled:opacity-50"
                  >
                    {busy === "sign" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PenLine className="h-3.5 w-3.5" />}
                    Co-sign with connected wallet
                  </button>
                )}
                <button
                  onClick={() => void submit()}
                  disabled={busy !== null || !fullySigned || txHash !== null}
                  className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
                >
                  {busy === "submit" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                  Submit
                </button>
                <button
                  onClick={reset}
                  disabled={busy !== null}
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  Discard
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {error && (
        <p className="mt-4 flex items-start gap-2 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {error}
        </p>
      )}
      {notice && <p className="mt-4 text-sm text-warning">{notice}</p>}
      {txHash && (
        <p className="mt-4 flex items-center gap-2 text-sm text-success">
          <CheckCircle2 className="h-3.5 w-3.5" /> Submitted —{" "}
          <a
            href={cardanoscanTx(txHash)}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:underline"
          >
            {txHash.slice(0, 12)}…
          </a>
          {recorded && " (recorded)"}
        </p>
      )}
    </div>
  );
}

function sharePriceOf(state: { totalAssets: string; totalShares: string }): number {
  const shares = Number(state.totalShares);
  if (!Number.isFinite(shares) || shares <= 0) return 1;
  return Number(state.totalAssets) / shares;
}
