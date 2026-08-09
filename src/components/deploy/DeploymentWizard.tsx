/**
 * Live deployment wizard (Preprod).
 *
 * Walks an admin through putting both validators on chain for a single asset:
 *
 *   1. Preflight    — network, wallet, role, and blueprint checks
 *   2. Derive       — applied script hashes + addresses for this asset
 *   3. Yield vault  — sign the bootstrap tx that creates the State UTxO,
 *                     then record the address in the vault registry
 *   4. Vault (v2)   — a first deposit, which is what witnesses the Stage 3
 *                     script on chain (that validator has no bootstrap UTxO)
 *   5. Verify       — read the deployed state back from the chain
 *
 * Nothing here is simulated: every "done" state is backed by a submitted
 * transaction hash or a Blockfrost read.
 */

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Loader2,
  Rocket,
  ShieldCheck,
} from "lucide-react";
import { Badge } from "@/components/ui/StatusBadge";
import { supabase } from "@/integrations/supabase/client";
import { getMyRoles, listAssetVaults, registerAssetVault } from "@/lib/asset-vaults.functions";
import { getVaultChainState } from "@/lib/yield-chain.functions";
import {
  bootstrapYieldVault,
  deriveYieldVaultAddress,
  getConnectedOperatorKeyHash,
  validateCommittee,
} from "@/lib/vault-bootstrap";
import {
  DEFAULT_VAULT_ASSET_ID,
  VAULT_BLUEPRINT_HASH,
  VAULT_VERSION,
  checkVaultPreconditions,
  decodeVaultError,
  depositAdaToVault,
  getVaultScript,
  initLucidReadOnly,
} from "@/lib/vault";
import { YIELD_BLUEPRINT_HASH, YIELD_VAULT_VERSION } from "@/lib/yield-vault";
import { APP_NETWORK, NETWORK_LABEL } from "@/lib/network";
import { MAX_FEE_BPS, formatFeeBps } from "@/lib/vault-fees";
import { cardanoscanAddress, cardanoscanTx, lovelaceToAda, short } from "@/lib/chain-format";
import { useWallet } from "@/lib/wallet-store";

interface AssetLite {
  id: string;
  name: string;
}

interface Derived {
  yieldAddress: string;
  yieldHash: string;
  vaultAddress: string;
  vaultHash: string;
}

export function DeploymentWizard() {
  const wallet = useWallet();
  const rolesQ = useQuery({ queryKey: ["my-roles"], queryFn: () => getMyRoles(), retry: 0 });
  const vaultsQ = useQuery({ queryKey: ["asset-vaults"], queryFn: () => listAssetVaults() });

  const [assets, setAssets] = useState<AssetLite[] | null>(null);
  useEffect(() => {
    supabase
      .from("assets")
      .select("id, name")
      .order("name")
      .then(({ data }) => setAssets((data as AssetLite[] | null) ?? []));
  }, []);

  const [assetId, setAssetId] = useState<string>(DEFAULT_VAULT_ASSET_ID);
  const [derived, setDerived] = useState<Derived | null>(null);
  const [deriveErr, setDeriveErr] = useState<string | null>(null);
  const [deriving, setDeriving] = useState(false);

  const [operators, setOperators] = useState<string>("");
  const [threshold, setThreshold] = useState(1);
  const [feeBps, setFeeBps] = useState(0);
  const [treasury, setTreasury] = useState("");
  const [bootstrapping, setBootstrapping] = useState(false);
  const [bootstrapTx, setBootstrapTx] = useState<string | null>(null);
  const [bootstrapErr, setBootstrapErr] = useState<string | null>(null);

  const [depositAda, setDepositAda] = useState("3");
  const [depositing, setDepositing] = useState(false);
  const [depositTx, setDepositTx] = useState<string | null>(null);
  const [depositErr, setDepositErr] = useState<string | null>(null);

  const [verifying, setVerifying] = useState(false);
  const [verifyErr, setVerifyErr] = useState<string | null>(null);
  const [verified, setVerified] = useState<{
    found: boolean;
    locked: string;
    stateTx: string | null;
  } | null>(null);

  const [sfm02Verifying, setSfm02Verifying] = useState(false);
  const [sfm02VerifyErr, setSfm02VerifyErr] = useState<string | null>(null);
  const [sfm02Verified, setSfm02Verified] = useState<{
    derivedAddress: string;
    registeredAddress: string | null;
    addressMatches: boolean;
    found: boolean;
    locked: string;
    stateTx: string | null;
  } | null>(null);

  const roles = rolesQ.data?.roles ?? [];
  const isAdmin = roles.includes("admin");
  const signedOut = Boolean(rolesQ.error);
  const pre = checkVaultPreconditions();
  const preflightOk = pre.ok && isAdmin;

  const existing = useMemo(
    () => (vaultsQ.data ?? []).find((v) => v.asset_id === assetId) ?? null,
    [vaultsQ.data, assetId],
  );

  // Reset the downstream steps whenever the target asset changes.
  useEffect(() => {
    setDerived(null);
    setDeriveErr(null);
    setBootstrapTx(null);
    setBootstrapErr(null);
    setDepositTx(null);
    setDepositErr(null);
    setVerified(null);
    setVerifyErr(null);
  }, [assetId]);

  async function runDerive() {
    setDeriving(true);
    setDeriveErr(null);
    try {
      const y = await deriveYieldVaultAddress(assetId);
      const { lucid, lucidMod } = await initLucidReadOnly();
      const v = await getVaultScript(lucid, lucidMod, assetId);
      setDerived({
        yieldAddress: y.address,
        yieldHash: y.scriptHash,
        vaultAddress: v.address,
        vaultHash: v.scriptHash,
      });
    } catch (e) {
      setDeriveErr(e instanceof Error ? e.message : String(e));
    } finally {
      setDeriving(false);
    }
  }

  async function useMyKey() {
    try {
      const pkh = await getConnectedOperatorKeyHash();
      setOperators((prev) => (prev.trim() ? prev : pkh));
      setTreasury((prev) => (prev.trim() ? prev : pkh));
    } catch (e) {
      setBootstrapErr(e instanceof Error ? e.message : String(e));
    }
  }

  const operatorList = operators
    .split(/[\s,]+/)
    .map((o) => o.trim().toLowerCase())
    .filter(Boolean);
  const committee = validateCommittee(operatorList, threshold);

  async function runBootstrap() {
    setBootstrapping(true);
    setBootstrapErr(null);
    try {
      const res = await bootstrapYieldVault({
        assetId,
        operators: operatorList,
        threshold,
        feeBps,
        treasuryPkh: treasury.trim().toLowerCase() || undefined,
      });
      setBootstrapTx(res.txHash);
      await registerAssetVault({
        data: {
          assetId: res.assetId,
          vaultVersion: res.vaultVersion,
          network: APP_NETWORK,
          scriptHash: res.scriptHash,
          scriptAddress: res.address,
          operators: res.operators,
          threshold: res.threshold,
          bootstrapTxHash: res.txHash,
        },
      });
      vaultsQ.refetch();
    } catch (e) {
      setBootstrapErr(decodeVaultError(e));
    } finally {
      setBootstrapping(false);
    }
  }

  async function runDeposit() {
    setDepositing(true);
    setDepositErr(null);
    try {
      const res = await depositAdaToVault(Number(depositAda), assetId);
      setDepositTx(res.txHash);
    } catch (e) {
      setDepositErr(decodeVaultError(e));
    } finally {
      setDepositing(false);
    }
  }

  async function runVerify() {
    const address = derived?.yieldAddress ?? existing?.script_address;
    if (!address) return;
    setVerifying(true);
    setVerifyErr(null);
    try {
      const state = await getVaultChainState({ data: { address } });
      setVerified({
        found: state.found,
        locked: state.lockedLovelace,
        stateTx: state.stateUtxo?.txHash ?? null,
      });
    } catch (e) {
      setVerifyErr(e instanceof Error ? e.message : String(e));
    } finally {
      setVerifying(false);
    }
  }

  async function runSfm02Verify() {
    setSfm02Verifying(true);
    setSfm02VerifyErr(null);
    setSfm02Verified(null);
    try {
      const current = await deriveYieldVaultAddress("sfm-02");
      const registered = (vaultsQ.data ?? []).find((v) => v.asset_id === "sfm-02") ?? null;
      const state = await getVaultChainState({ data: { address: current.address } });
      setSfm02Verified({
        derivedAddress: current.address,
        registeredAddress: registered?.script_address ?? null,
        addressMatches: registered?.script_address === current.address,
        found: state.found,
        locked: state.lockedLovelace,
        stateTx: state.stateUtxo?.txHash ?? null,
      });
    } catch (e) {
      setSfm02VerifyErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSfm02Verifying(false);
    }
  }

  return (
    <section className="mt-10 card-institutional p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Rocket className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-semibold text-foreground">Live deployment wizard</h2>
        </div>
        <Badge tone={APP_NETWORK === "preprod" ? "accent" : "warning"}>{NETWORK_LABEL}</Badge>
      </div>
      <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
        Put the <code className="font-mono text-xs">yield_vault</code> and{" "}
        <code className="font-mono text-xs">vault</code> validators on chain for one asset. Each
        step below is a real transaction signed by your wallet — nothing is simulated.
      </p>

      {/* Step 1 — preflight ------------------------------------------------ */}
      <Step index={1} title="Preflight" done={preflightOk}>
        <ul className="flex flex-col gap-1.5 text-sm">
          <Check ok={APP_NETWORK === "preprod"}>
            App is pointed at Preprod ({APP_NETWORK})
          </Check>
          <Check ok={wallet.connected}>Wallet connected{wallet.provider ? ` (${wallet.provider})` : ""}</Check>
          <Check ok={pre.ok}>{pre.ok ? "Wallet network matches the app" : pre.reason}</Check>
          <Check ok={!signedOut && isAdmin}>
            {signedOut
              ? "Sign in — the registry write needs an authenticated admin"
              : isAdmin
                ? "Account holds the admin role"
                : "Account is missing the admin role; the registry write will be rejected"}
          </Check>
        </ul>
        <div className="mt-3 grid gap-2 text-[11px] text-muted-foreground sm:grid-cols-2">
          <div className="rounded-lg border border-border p-2">
            yield_vault blueprint v{String(YIELD_VAULT_VERSION)} ·{" "}
            <span className="font-mono">{short(YIELD_BLUEPRINT_HASH, 12, 8)}</span>
          </div>
          <div className="rounded-lg border border-border p-2">
            vault blueprint v{String(VAULT_VERSION)} ·{" "}
            <span className="font-mono">{short(VAULT_BLUEPRINT_HASH, 12, 8)}</span>
          </div>
        </div>
      </Step>

      {/* Step 2 — derive ---------------------------------------------------- */}
      <Step index={2} title="Derive the applied scripts" done={Boolean(derived)}>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Asset
            <select
              value={assetId}
              onChange={(e) => setAssetId(e.target.value)}
              className="min-w-56 rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
            >
              {(assets ?? []).length === 0 && <option value={assetId}>{assetId}</option>}
              {(assets ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.id} — {a.name}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={runDerive}
            disabled={deriving}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-50"
          >
            {deriving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Derive &amp; verify hashes
          </button>
        </div>
        {deriveErr && <ErrorNote>{deriveErr}</ErrorNote>}
        {existing && (
          <div className="mt-3 rounded-lg border border-border bg-secondary/40 p-3 text-[11px] text-muted-foreground">
            This asset already has a registered vault at{" "}
            <span className="font-mono">{short(existing.script_address, 12, 8)}</span>. Deploying
            again creates a second ledger — use the re-bootstrap flow on the operator console
            instead unless the script hash changed.
          </div>
        )}
        {derived && (
          <div className="mt-3 grid gap-2 text-[11px] sm:grid-cols-2">
            <Addr label="yield_vault" hash={derived.yieldHash} address={derived.yieldAddress} />
            <Addr label="vault" hash={derived.vaultHash} address={derived.vaultAddress} />
          </div>
        )}
      </Step>

      {/* Step 3 — bootstrap the yield vault --------------------------------- */}
      <Step index={3} title="Deploy the yield vault state UTxO" done={Boolean(bootstrapTx)}>
        <p className="text-sm text-muted-foreground">
          Creates the single ledger UTxO every deposit, accrual, and redemption balances against,
          and fixes the operator committee.
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-xs text-muted-foreground sm:col-span-2">
            Operator payment key hashes (comma or space separated)
            <textarea
              rows={2}
              value={operators}
              onChange={(e) => setOperators(e.target.value)}
              placeholder="56-character hex key hashes"
              className="rounded-lg border border-border bg-background px-3 py-2 font-mono text-xs text-foreground"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Signature threshold
            <input
              type="number"
              min={1}
              value={threshold}
              onChange={(e) => setThreshold(Number(e.target.value))}
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Management fee ({formatFeeBps(feeBps)}, max {formatFeeBps(MAX_FEE_BPS)})
            <input
              type="number"
              min={0}
              max={MAX_FEE_BPS}
              value={feeBps}
              onChange={(e) => setFeeBps(Number(e.target.value))}
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground sm:col-span-2">
            Treasury payment key hash {feeBps > 0 ? "(required)" : "(optional)"}
            <input
              value={treasury}
              onChange={(e) => setTreasury(e.target.value)}
              className="rounded-lg border border-border bg-background px-3 py-2 font-mono text-xs text-foreground"
            />
          </label>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={useMyKey}
            className="rounded-lg border border-border px-3 py-2 text-xs font-medium text-foreground"
          >
            Use my connected wallet key
          </button>
          <button
            type="button"
            onClick={runBootstrap}
            disabled={!preflightOk || !derived || !committee.ok || bootstrapping}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-50"
          >
            {bootstrapping && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Sign &amp; submit bootstrap tx
          </button>
          {operatorList.length > 0 && !committee.ok && (
            <span className="text-[11px] text-destructive">{committee.reason}</span>
          )}
        </div>
        {bootstrapErr && <ErrorNote>{bootstrapErr}</ErrorNote>}
        {bootstrapTx && <TxNote label="Bootstrap submitted" hash={bootstrapTx} />}
      </Step>

      {/* Step 4 — witness the Stage 3 vault --------------------------------- */}
      <Step index={4} title="Witness the vault validator with a first deposit" done={Boolean(depositTx)}>
        <p className="text-sm text-muted-foreground">
          The Stage 3 <code className="font-mono text-xs">vault</code> validator has no state UTxO —
          it only appears on chain once a transaction pays into its address. A small self-owned
          deposit deploys and proves it; you can withdraw it afterwards from the portfolio.
        </p>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Deposit (ADA)
            <input
              type="number"
              min={2}
              step="0.5"
              value={depositAda}
              onChange={(e) => setDepositAda(e.target.value)}
              className="w-32 rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
            />
          </label>
          <button
            type="button"
            onClick={runDeposit}
            disabled={!pre.ok || !derived || depositing}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-50"
          >
            {depositing && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Sign &amp; submit deposit
          </button>
        </div>
        {depositErr && <ErrorNote>{depositErr}</ErrorNote>}
        {depositTx && <TxNote label="Deposit submitted" hash={depositTx} />}
      </Step>

      {/* Step 5 — verify ---------------------------------------------------- */}
      <Step index={5} title="Verify on chain" done={Boolean(verified?.found)}>
        <p className="text-sm text-muted-foreground">
          Reads the vault address back through Blockfrost. Preprod blocks take ~20 seconds, so this
          may report nothing found for a moment after submitting.
        </p>
        <button
          type="button"
          onClick={runVerify}
          disabled={verifying || (!derived && !existing)}
          className="mt-3 inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs font-semibold text-foreground disabled:opacity-50"
        >
          {verifying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
          Check the deployed state
        </button>
        {verifyErr && <ErrorNote>{verifyErr}</ErrorNote>}
        {verified && (
          <div className="mt-3 rounded-lg border border-border p-3 text-[11px] text-muted-foreground">
            {verified.found ? (
              <>
                State UTxO live · {lovelaceToAda(verified.locked)} ADA locked
                {verified.stateTx && (
                  <>
                    {" · "}
                    <a
                      href={cardanoscanTx(verified.stateTx)}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-primary hover:underline"
                    >
                      {short(verified.stateTx, 8, 6)} <ExternalLink className="h-3 w-3" />
                    </a>
                  </>
                )}
              </>
            ) : (
              "No state UTxO at this address yet — wait for the next block and check again."
            )}
          </div>
        )}
      </Step>
    </section>
  );
}

function Step({
  index,
  title,
  done,
  children,
}: {
  index: number;
  title: string;
  done: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-5 rounded-xl border border-border p-4">
      <div className="flex items-center gap-2">
        <div
          className={`grid h-6 w-6 place-items-center rounded-full text-[11px] font-semibold ${
            done ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground"
          }`}
        >
          {done ? <CheckCircle2 className="h-3.5 w-3.5" /> : index}
        </div>
        <h3 className="text-sm font-medium text-foreground">{title}</h3>
      </div>
      <div className="mt-3">{children}</div>
    </div>
  );
}

function Check({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      {ok ? (
        <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
      ) : (
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
      )}
      <span className={ok ? "text-muted-foreground" : "text-foreground"}>{children}</span>
    </li>
  );
}

function Addr({ label, hash, address }: { label: string; hash: string; address: string }) {
  return (
    <div className="rounded-lg border border-border p-3">
      <div className="text-[10px] uppercase tracking-widest text-muted-foreground">{label}</div>
      <div className="mt-1 font-mono text-[11px] text-foreground">{short(hash, 14, 8)}</div>
      <a
        href={cardanoscanAddress(address)}
        target="_blank"
        rel="noreferrer"
        className="mt-1 inline-flex items-center gap-1 font-mono text-[11px] text-primary hover:underline"
      >
        {short(address, 14, 8)} <ExternalLink className="h-3 w-3" />
      </a>
    </div>
  );
}

function ErrorNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-3 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

function TxNote({ label, hash }: { label: string; hash: string }) {
  return (
    <div className="mt-3 flex items-center gap-2 rounded-md border border-primary/40 bg-primary/10 p-3 text-xs text-foreground">
      <CheckCircle2 className="h-3.5 w-3.5 text-primary" />
      {label} ·{" "}
      <a
        href={cardanoscanTx(hash)}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1 font-mono text-primary hover:underline"
      >
        {short(hash, 10, 6)} <ExternalLink className="h-3 w-3" />
      </a>
    </div>
  );
}
