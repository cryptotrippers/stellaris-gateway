import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Button } from "@/components/ui/button";
import { AlertTriangle, CheckCircle2, Layers, Loader2 } from "lucide-react";
import { TxConfirmationBadge } from "@/components/vault/TxConfirmationBadge";
import { CopyRow } from "@/components/ui/CopyRow";
import { listDepositAssets } from "@/lib/deposit-assets.functions";
import { depositAssetUnit, isAdaAsset, type DepositAsset } from "@/lib/deposit-assets.shared";
import { getConnectedOperatorKeyHash } from "@/lib/vault-bootstrap";
import { FRACTION_VAULT_VERSION, unitOf } from "@/lib/fraction-vault";
import { openOffering } from "@/lib/offering-tx";
import { registerOffering } from "@/lib/offerings.functions";
import { recordFractionEvent } from "@/lib/fraction-events.functions";
import { APP_NETWORK } from "@/lib/network";
import { cardanoscanAddress, short } from "@/lib/chain-format";
import type { VaultSeed } from "@/lib/vault-instances";
import {
  PENDING_OFFERING_KEY, pendingOfferingSchema, priceInBaseUnits, registryInteger,
  retryOfferingRegistration, type PendingOffering,
} from "@/lib/offering-registration.shared";

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
  const [pending, setPending] = useState<PendingOffering | null>(null);
  const [restored, setRestored] = useState(false);
  const [storageWarning, setStorageWarning] = useState<string | null>(null);
  const register = useServerFn(registerOffering);
  const record = useServerFn(recordFractionEvent);
  const [result, setResult] = useState<{
    txHash: string;
    address: string;
    fractionUnit: string;
    seed: VaultSeed;
  } | null>(null);

  useEffect(() => {
    if (!denomId && denominations[0]) setDenomId(denominations[0].id);
  }, [denominations, denomId]);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(PENDING_OFFERING_KEY);
      if (saved) {
        const opening = pendingOfferingSchema.parse(JSON.parse(saved));
        setPending(opening);
        setAssetId(opening.payload.assetId);
      }
    } catch {
      setStorageWarning("Saved opening details could not be read. Keep this page open after signing so you can retry listing.");
    } finally {
      setRestored(true);
    }
  }, []);

  const denom: DepositAsset | null = denominations.find((d) => d.id === denomId) ?? null;

  const priceBase = priceInBaseUnits(priceAda, denom?.decimals ?? 6);
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

  async function finishListing(opening: PendingOffering) {
    await retryOfferingRegistration(opening, (payload) => register({ data: payload }), async () => {
      setError("Submitted — waiting for Preprod to confirm before listing…");
      await new Promise((resolve) => setTimeout(resolve, 10_000));
    });
    setError(null);
    record({ data: { assetId: opening.payload.assetId, txHash: opening.payload.bootstrapTxHash } }).catch(() => {});
    setResult({
      txHash: opening.payload.bootstrapTxHash,
      address: opening.payload.scriptAddress,
      fractionUnit: opening.payload.fractionPolicyId + opening.payload.fractionAssetNameHex,
      seed: opening.seed,
    });
    setPending(null);
    try { localStorage.removeItem(PENDING_OFFERING_KEY); } catch { /* In-memory result remains available. */ }
    onDone?.();
  }

  async function retryListing() {
    if (!pending || disabled || busy) return;
    setBusy(true);
    setError(null);
    try { await finishListing(pending); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function submit() {
    if (!denom || !keyHash || pending || result || !restored || busy || disabled) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const exactFractions = registryInteger(fractions);
      const exactPrice = registryInteger(priceBase);
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
        vaultVersion: Number(FRACTION_VAULT_VERSION),
        scriptHash: opened.scriptHash,
        scriptAddress: opened.address,
        fractionPolicyId: opened.policyId,
        fractionAssetNameHex: opened.assetNameHex,
        depositAssetId: denom.id,
        totalFractions: exactFractions,
        pricePerFraction: exactPrice,
        mintFeeBps: Number(mintFeeBps),
        redeemFeeBps: Number(redeemFeeBps),
        issuerName: issuerName.trim() || "Stellaris",
        treasuryAddress: null,
        operatorKeyHashes: [keyHash],
        signatureThreshold: 1,
        bootstrapTxHash: opened.txHash,
      };
      // Keep the original transaction before the first network-dependent listing call.
      const opening: PendingOffering = { payload, seed: opened.seed };
      setPending(opening);
      try { localStorage.setItem(PENDING_OFFERING_KEY, JSON.stringify(opening)); }
      catch { setStorageWarning("Opening details could not be saved on this device. Keep this page open until listing succeeds."); }
      await finishListing(opening);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const ready =
    !disabled &&
    !busy &&
    restored && !pending && !result &&
    Boolean(assetId) &&
    Boolean(denom) &&
    Boolean(keyHash) &&
    fractions > 0n &&
    priceBase > 0n &&
    fractions <= BigInt(Number.MAX_SAFE_INTEGER) &&
    priceBase <= BigInt(Number.MAX_SAFE_INTEGER) &&
    Number(mintFeeBps) <= 500 && Number(redeemFeeBps) <= 500;

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
            <Button
              type="button"
              onClick={loadKey}
              disabled={disabled}
              className="shrink-0 rounded-md border border-border px-3 py-2 text-xs text-foreground disabled:opacity-50"
            >
              Read
            </Button>
          </div>
        </Field>
      </div>

      {assetId && denom && !result && (
        <div className="mt-4 rounded-md border border-border p-3 text-[11px] text-muted-foreground">
          The offering address is fixed by the opening transaction and shown once it confirms.
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

      <Button
        type="button"
        onClick={submit}
        disabled={!ready}
        className="mt-4 inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
      >
        {busy && <Loader2 className="h-4 w-4 animate-spin" />} Open the offering on {APP_NETWORK}
      </Button>

      {storageWarning && <p className="mt-3 text-xs text-muted-foreground">{storageWarning}</p>}
      {pending && (
        <div className="mt-4 rounded-md border border-border p-4 text-xs">
          <p className="font-semibold text-foreground">Opening submitted — listing pending</p>
          <p className="mt-2 text-muted-foreground">Retry listing this same transaction. No new payment or wallet signature is required.</p>
          <div className="mt-3 grid gap-2">
            <CopyRow label="Opening transaction" value={pending.payload.bootstrapTxHash} />
            <CopyRow label="Offering address" value={pending.payload.scriptAddress} />
            <CopyRow label="Seed" value={`${pending.seed.txHash}#${pending.seed.outputIndex}`} />
          </div>
          <Button className="mt-3" variant="outline" size="sm" onClick={retryListing} disabled={disabled || busy}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />} Retry listing
          </Button>
          <TxConfirmationBadge txHash={pending.payload.bootstrapTxHash} />
        </div>
      )}

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
          <div className="mt-2 grid gap-2">
            <div>
              <div className="text-muted-foreground">Fraction token ID</div>
              <div className="mt-0.5 break-all font-mono text-foreground">{result.fractionUnit}</div>
            </div>
            <CopyRow label="Seed" value={`${result.seed.txHash}#${result.seed.outputIndex}`} />
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">
            Developer step: pin this seed in src/lib/vault-instances.ts under OFFERING_SEEDS[&quot;
            {assetId}:&quot;] (ADA) as {"{ txHash: \"...\", outputIndex: N }"}.
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
