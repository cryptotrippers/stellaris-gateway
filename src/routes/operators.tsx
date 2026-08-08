import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, ExternalLink, Loader2, ShieldCheck, Wallet } from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import { Badge } from "@/components/ui/StatusBadge";
import { supabase } from "@/integrations/supabase/client";
import { getMyRoles, listAssetVaults, registerAssetVault } from "@/lib/asset-vaults.functions";
import {
  bootstrapYieldVault,
  deriveYieldVaultAddress,
  getConnectedOperatorKeyHash,
  validateCommittee,
} from "@/lib/vault-bootstrap";
import { cardanoscanAddress, cardanoscanTx, short } from "@/lib/chain-format";

export const Route = createFileRoute("/operators")({
  head: () => ({
    meta: [
      { title: "Operator Console · Stellaris Finance" },
      {
        name: "description",
        content:
          "Bootstrap a vault's on-chain ledger, define its operator committee and signature threshold, and register it against a real-world asset.",
      },
      { property: "og:title", content: "Stellaris · Operator Console" },
      {
        property: "og:description",
        content: "Committee setup and vault bootstrap for Stellaris yield vaults.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: OperatorConsole,
});

interface AssetLite {
  id: string;
  name: string;
}

function OperatorConsole() {
  const rolesQ = useQuery({
    queryKey: ["my-roles"],
    queryFn: () => getMyRoles(),
    retry: 0,
  });

  const vaultsQ = useQuery({
    queryKey: ["asset-vaults"],
    queryFn: () => listAssetVaults(),
  });

  const [assets, setAssets] = useState<AssetLite[] | null>(null);
  useEffect(() => {
    supabase
      .from("assets")
      .select("id, name")
      .order("name")
      .then(({ data }) => setAssets((data as AssetLite[] | null) ?? []));
  }, []);

  const roles = rolesQ.data?.roles ?? [];
  const isAdmin = roles.includes("admin");
  const signedOut = Boolean(rolesQ.error);

  const registered = new Set((vaultsQ.data ?? []).map((v) => v.asset_id));
  const unbootstrapped = (assets ?? []).filter((a) => !registered.has(a.id));

  return (
    <AppShell>
      <div>
        <div className="text-[11px] uppercase tracking-[0.22em] text-primary">Operator console</div>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight text-foreground">
          Vault bootstrap &amp; committee
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          A vault has no share price until its state UTxO exists on chain. Creating it also fixes
          the operator committee and the number of signatures every future accrual will need.
        </p>
      </div>

      {signedOut && (
        <div className="mt-6 card-institutional p-6 text-sm text-muted-foreground">
          Sign in to see whether your account holds an operator or admin role.
        </div>
      )}

      {!signedOut && rolesQ.data && (
        <div className="mt-6 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">Your roles:</span>
          {roles.length === 0 ? (
            <Badge tone="muted">none</Badge>
          ) : (
            roles.map((r) => <Badge key={r} tone="accent">{r}</Badge>)
          )}
        </div>
      )}

      {!signedOut && rolesQ.data && !isAdmin && (
        <div className="mt-4 flex items-start gap-3 rounded-lg border border-warning/40 bg-warning/10 p-4 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <div>
            Bootstrapping a vault is restricted to admins. You can review existing vaults below, but
            registration will be rejected.
          </div>
        </div>
      )}

      <section className="mt-8">
        <h2 className="text-sm font-medium text-foreground">Registered vaults</h2>
        {vaultsQ.isLoading && (
          <div className="mt-3 card-institutional p-5 text-sm text-muted-foreground">Loading…</div>
        )}
        {vaultsQ.data && vaultsQ.data.length === 0 && (
          <div className="mt-3 card-institutional p-5 text-sm text-muted-foreground">
            No vault ledgers exist yet.
          </div>
        )}
        <div className="mt-3 flex flex-col gap-2">
          {(vaultsQ.data ?? []).map((v) => (
            <div
              key={v.id}
              className="card-institutional flex flex-wrap items-center justify-between gap-3 p-4 text-sm"
            >
              <div>
                <div className="font-medium text-foreground">{v.asset_id}</div>
                <a
                  href={cardanoscanAddress(v.script_address)}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-[11px] text-muted-foreground hover:text-primary"
                >
                  {short(v.script_address, 14, 8)}
                </a>
              </div>
              <div className="text-[11px] text-muted-foreground">
                {v.signature_threshold}-of-{v.operator_key_hashes.length} · v{v.vault_version}
              </div>
              {v.bootstrap_tx_hash && (
                <a
                  href={cardanoscanTx(v.bootstrap_tx_hash)}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 font-mono text-[11px] text-muted-foreground hover:text-primary"
                >
                  {short(v.bootstrap_tx_hash, 8, 6)} <ExternalLink className="h-3 w-3" />
                </a>
              )}
            </div>
          ))}
        </div>
      </section>

      <BootstrapForm
        assets={unbootstrapped}
        disabled={!isAdmin}
        onDone={() => {
          vaultsQ.refetch();
        }}
      />
    </AppShell>
  );
}

function BootstrapForm({
  assets,
  disabled,
  onDone,
}: {
  assets: AssetLite[];
  disabled: boolean;
  onDone: () => void;
}) {
  const [assetId, setAssetId] = useState("");
  const [operatorsText, setOperatorsText] = useState("");
  const [threshold, setThreshold] = useState(1);
  const [address, setAddress] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "derive" | "wallet" | "submit">(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ txHash: string; address: string } | null>(null);

  const operators = operatorsText
    .split(/[\s,]+/)
    .map((o) => o.trim().toLowerCase())
    .filter(Boolean);

  useEffect(() => {
    setAddress(null);
    setResult(null);
    setError(null);
    if (!assetId) return;
    let cancelled = false;
    setBusy("derive");
    deriveYieldVaultAddress(assetId)
      .then((s) => {
        if (!cancelled) setAddress(s.address);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setBusy(null);
      });
    return () => {
      cancelled = true;
    };
  }, [assetId]);

  const addSelf = async () => {
    setError(null);
    setBusy("wallet");
    try {
      const hash = await getConnectedOperatorKeyHash();
      setOperatorsText((t) => (t.includes(hash) ? t : `${t.trim()}\n${hash}`.trim()));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const submit = async () => {
    setError(null);
    const committee = validateCommittee(operators, threshold);
    if (!committee.ok) {
      setError(committee.reason);
      return;
    }
    setBusy("submit");
    try {
      const res = await bootstrapYieldVault({ assetId, operators, threshold });
      await registerAssetVault({
        data: {
          assetId: res.assetId,
          vaultVersion: res.vaultVersion,
          scriptHash: res.scriptHash,
          scriptAddress: res.address,
          operators: res.operators,
          threshold: res.threshold,
          bootstrapTxHash: res.txHash,
        },
      });
      setResult({ txHash: res.txHash, address: res.address });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="mt-10 card-institutional p-6">
      <h2 className="text-sm font-medium text-foreground">Bootstrap a vault ledger</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        One transaction per asset. It cannot be repeated — a second state UTxO would break the
        vault&apos;s accounting invariant.
      </p>

      <div className="mt-5 grid gap-5 md:grid-cols-2">
        <label className="text-sm">
          <span className="text-muted-foreground">Asset</span>
          <select
            value={assetId}
            onChange={(e) => setAssetId(e.target.value)}
            className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
          >
            <option value="">Select an asset…</option>
            {assets.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({a.id})
              </option>
            ))}
          </select>
          {assets.length === 0 && (
            <span className="mt-1 block text-[11px] text-muted-foreground">
              Every registered asset already has a vault ledger.
            </span>
          )}
        </label>

        <label className="text-sm">
          <span className="text-muted-foreground">Signature threshold</span>
          <input
            type="number"
            min={1}
            max={Math.max(1, operators.length)}
            value={threshold}
            onChange={(e) => setThreshold(Number(e.target.value))}
            className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm tabular-nums"
          />
          <span className="mt-1 block text-[11px] text-muted-foreground">
            {threshold}-of-{operators.length || "?"} operators must sign each accrual.
          </span>
        </label>
      </div>

      <div className="mt-5">
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">Operator payment key hashes</span>
          <button
            type="button"
            onClick={addSelf}
            disabled={busy !== null}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-[11px] text-foreground hover:bg-secondary/40 disabled:opacity-50"
          >
            <Wallet className="h-3 w-3" /> Add connected wallet
          </button>
        </div>
        <textarea
          value={operatorsText}
          onChange={(e) => setOperatorsText(e.target.value)}
          rows={4}
          placeholder="One 56-character hex key hash per line"
          className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-xs"
        />
      </div>

      {address && (
        <div className="mt-4 rounded-md border border-border bg-secondary/20 p-3 text-xs">
          <div className="text-muted-foreground">Derived vault address for this asset</div>
          <div className="mt-1 break-all font-mono text-foreground">{address}</div>
        </div>
      )}

      {error && (
        <div className="mt-4 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {result && (
        <div className="mt-4 flex items-start gap-2 rounded-md border border-success/40 bg-success/10 p-3 text-sm text-success">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Vault ledger created.{" "}
            <a
              href={cardanoscanTx(result.txHash)}
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              View transaction
            </a>
          </span>
        </div>
      )}

      <button
        type="button"
        onClick={submit}
        disabled={disabled || busy !== null || !assetId || operators.length === 0}
        className="mt-5 inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
      >
        {busy === "submit" ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
        {busy === "submit" ? "Awaiting wallet signature…" : "Bootstrap vault ledger"}
      </button>
    </section>
  );
}
