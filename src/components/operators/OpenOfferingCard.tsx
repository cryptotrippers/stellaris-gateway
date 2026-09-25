import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Layers, Loader2 } from "lucide-react";
import { TxConfirmationBadge } from "@/components/vault/TxConfirmationBadge";
import { listDepositAssets } from "@/lib/deposit-assets.functions";
import { depositAssetUnit, isAdaAsset, type DepositAsset } from "@/lib/deposit-assets.shared";
import { getConnectedOperatorKeyHash } from "@/lib/vault-bootstrap";
import { deriveOffering, unitOf } from "@/lib/fraction-vault";
import { openOffering } from "@/lib/offering-tx";
import { registerOffering } from "@/lib/offerings.functions";
import { recordFractionEvent } from "@/lib/fraction-events.functions";
import { APP_NETWORK } from "@/lib/network";
import { cardanoscanAddress, short } from "@/lib/chain-format";

interface AssetOption {
  id: string;
  name: string;
}

/**
 * Open an asset for fractional ownership on Preprod.
 *
 * This single transaction fixes everything the offering can never change
 * later: how many fractions exist, what one costs, who the committee is, and
 * where fee revenue may be paid. It is deliberately a one-way door, so the
 * form shows the exact figures before anything is signed.
 */
export function OpenOfferingCard({
  assets,
  registeredAssetIds,
  disabled,
  onDone,
}: {
  assets: AssetOption[];
  registeredAssetIds: Set<string>;
  disabled: boolean;
  onDone?: () => void;
}) {
  const depositQ = useQuery({ queryKey: ["deposit-assets"], queryFn: () => listDepositAssets() });
  const denominations = useMemo(
    () => (depositQ.data ?? []).filter((d) => d.network === APP_NETWORK && isAdaAsset(d)),
    [depositQ.data],
  );

  const available = assets.filter((a) => !registeredAssetIds.has(a.id));

  const [assetId, setAssetId] = useState("");
  const [denomId, setDenomId] = useState("");
  const [totalFractions, setTotalFractions] = useState("1000");
  const [priceAda, setPriceAda] = useState("1");
  const [mintFeeBps, setMintFeeBps] = useState("0");
  const [redeemFeeBps, setRedeemFeeBps] = useState("0");
  const [issuerName, setIssuerName] = useState("");
  const [keyHash, setKeyHash] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ txHash: string; address: string } | null>(null);

  useEffect(() => {
    if (!denomId && denominations[0]) setDenomId(denominations[0].id);
  }, [denominations, denomId]);

  const denom: DepositAsset | null = denominations.find((d) => d.id === denomId) ?? null;

  const [preview, setPreview] = useState<{ address: string; unit: string } | null>(null);
  useEffect(() => {
    setPreview(null);
    if (!assetId || !denom) return;
    let live = true;
    deriveOffering(assetId, unitOf(denom))
      .then((s) => live && setPreview({ address: s.address, unit: s.fractionUnit }))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [assetId, denom]);

  const priceBase = (() => {
    const n = Number(priceAda);
    if (!Number.isFinite(n) || n <= 0) return 0n;
    return BigInt(Math.round(n * 10 ** (denom?.decimals ?? 6)));
  })();
  const fractions = (() => {
    try {
      return BigInt(totalFractions || "0");
    } catch {
      return 0n;
    }
  })();
  const raiseAda = denom ? (Number(priceBase * fractions) / 10 ** denom.decimals).toLocaleString() : "—";

  async function loadKey() {
    setError(null);
    try {
      setKeyHash(await getConnectedOperatorKeyHash());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function submit() {
    if (!denom || !keyHash) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const unit = unitOf(denom);
      const opened = await openOffering({
        assetId,
        unit,
        totalFractions: fractions,
        price: priceBase,
        operators: [keyHash],
        threshold: 1,
        issuerPkh: keyHash,
        treasuryPkh: keyHash,
        mintFeeBps: Number(mintFeeBps),
        redeemFeeBps: Number(redeemFeeBps),
      });

      const payload = {
        assetId,
        network: APP_NETWORK,
        vaultVersion: 1,
        scriptHash: opened.scriptHash,
        scriptAddress: opened.address,
        fractionPolicyId: opened.policyId,
        fractionAssetNameHex: opened.assetNameHex,
        depositAssetId: denom.id,
        totalFractions: Number(fractions),
        pricePerFraction: Number(priceBase),
        mintFeeBps: Number(mintFeeBps),
        redeemFeeBps: Number(redeemFeeBps),
        issuerName: issuerName.trim() || "Stellaris",
        treasuryAddress: null,
        operatorKeyHashes: [keyHash],
        signatureThreshold: 1,
        bootstrapTxHash: opened.txHash,
      };
      // List only once the chain confirms the opening (up to ~5 minutes).
      for (let i = 0; ; i++) {
        try {
          await registerOffering({ data: payload });
          break;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (!msg.includes("NOT_CONFIRMED") || i >= 30) throw e;
          setError("Submitted — waiting for Preprod to confirm before listing…");
          await new Promise((r) => setTimeout(r, 10_000));
        }
      }
      setError(null);

      // Best effort: the chain record is written as soon as the tx is visible.
      recordFractionEvent({ data: { assetId, txHash: opened.txHash } }).catch(() => {});

      setResult({ txHash: opened.txHash, address: opened.address });
      onDone?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const ready =
    !disabled &&
    !busy &&
    Boolean(assetId) &&
    Boolean(denom) &&
    Boolean(keyHash) &&
    fractions > 0n &&
    priceBase > 0n;

  return (
    <section className="card-institutional mt-8 p-6">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <Layers className="h-4 w-4 text-primary" /> Open an asset for fractional ownership
      </h2>
      <p className="mt-1 text-xs text-muted-foreground">
        One transaction on {APP_NETWORK} fixes the number of fractions, the price of one, the
        committee and the fee rates. None of it can be changed afterwards except the fee rates and
        the sale status, and only by the committee.
      </p>

      {disabled && (
        <p className="mt-3 text-xs text-muted-foreground">
          Sign in as an administrator with the master wallet connected to use this.
        </p>
      )}

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <Field label="Asset">
          <select
            value={assetId}
            onChange={(e) => setAssetId(e.target.value)}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
            disabled={disabled}
          >
            <option value="">Choose an asset…</option>
            {available.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({a.id})
              </option>
            ))}
          </select>
        </Field>
        <Field label="Denomination">
          <select
            value={denomId}
            onChange={(e) => setDenomId(e.target.value)}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
            disabled={disabled}
          >
            {denominations.map((d) => (
              <option key={d.id} value={d.id}>
                {d.symbol} — {depositAssetUnit(d)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Total fractions">
          <input
            value={totalFractions}
            onChange={(e) => setTotalFractions(e.target.value.replace(/[^0-9]/g, ""))}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
            disabled={disabled}
            inputMode="numeric"
          />
        </Field>
        <Field label={`Price per fraction (${denom?.symbol ?? "ADA"})`}>
          <input
            value={priceAda}
            onChange={(e) => setPriceAda(e.target.value.replace(/[^0-9.]/g, ""))}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
            disabled={disabled}
            inputMode="decimal"
          />
        </Field>
        <Field label="Buy fee (basis points, max 500)">
          <input
            value={mintFeeBps}
            onChange={(e) => setMintFeeBps(e.target.value.replace(/[^0-9]/g, ""))}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
            disabled={disabled}
            inputMode="numeric"
          />
        </Field>
        <Field label="Redeem fee (basis points, max 500)">
          <input
            value={redeemFeeBps}
            onChange={(e) => setRedeemFeeBps(e.target.value.replace(/[^0-9]/g, ""))}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
            disabled={disabled}
            inputMode="numeric"
          />
        </Field>
        <Field label="Issuer name shown to buyers">
          <input
            value={issuerName}
            onChange={(e) => setIssuerName(e.target.value)}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
            disabled={disabled}
            placeholder="Stellaris"
          />
        </Field>
        <Field label="Committee (the connected wallet)">
          <div className="flex items-center gap-2">
            <input
              readOnly
              value={keyHash ?? ""}
              placeholder="Not read yet"
              className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-[11px] text-foreground"
            />
            <button
              type="button"
              onClick={loadKey}
              disabled={disabled}
              className="shrink-0 rounded-md border border-border px-3 py-2 text-xs text-foreground disabled:opacity-50"
            >
              Read
            </button>
          </div>
        </Field>
      </div>

      {preview && (
        <div className="mt-4 rounded-md border border-border p-3 text-[11px] text-muted-foreground">
          <p>Check before signing:</p>
          <p className="mt-1 break-all">
            Contract address: <span className="font-mono text-foreground">{preview.address}</span>
          </p>
          <p className="mt-1 break-all">
            Fraction token ID: <span className="font-mono text-foreground">{preview.unit}</span>
          </p>
        </div>
      )}
      <p className="mt-4 text-xs text-muted-foreground">
        If every fraction sells, this offering takes in{" "}
        <span className="text-foreground">
          {raiseAda} {denom?.symbol ?? ""}
        </span>
        , of which {Number(mintFeeBps || "0") / 100}% is kept as platform revenue and the rest backs
        the asset.
      </p>

      <button
        type="button"
        onClick={submit}
        disabled={!ready}
        className="mt-4 inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
      >
        {busy && <Loader2 className="h-4 w-4 animate-spin" />} Open the offering on {APP_NETWORK}
      </button>

      {error && (
        <p className="mt-3 flex items-start gap-2 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          {error}
        </p>
      )}
      {result && (
        <div className="mt-4 rounded-md border border-border bg-secondary/20 p-4 text-xs">
          <p className="flex items-center gap-2 text-sm text-success">
            <CheckCircle2 className="h-4 w-4" /> Offering opened and registered.
          </p>
          <p className="mt-2 break-all text-muted-foreground">
            Offering address:{" "}
            <a
              href={cardanoscanAddress(result.address)}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-primary hover:underline"
            >
              {short(result.address, 16, 10)}
            </a>
          </p>
          <TxConfirmationBadge txHash={result.txHash} />
        </div>
      )}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-xs">
      <span className="text-muted-foreground">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}
