import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Loader2, ShieldCheck, Wallet } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useWallet, shortAddr } from "@/lib/wallet-store";

export interface MasterWalletStatus {
  /** True when a master wallet is registered AND it is the wallet currently connected. */
  ok: boolean;
  loading: boolean;
  /** Registered master wallet addresses (empty until one is enrolled). */
  wallets: string[];
  refetch: () => void;
}

/**
 * Admin actions are authorised by the master wallet, not by the email account.
 * The signed-in admin still needs the master wallet connected in the browser.
 */
export function useMasterWallet(): MasterWalletStatus {
  const wallet = useWallet();
  const [wallets, setWallets] = useState<string[] | null>(null);

  const load = useCallback(() => {
    supabase
      .from("admin_wallets")
      .select("address")
      .then(({ data }) => setWallets((data ?? []).map((r) => r.address)));
  }, []);

  useEffect(() => load(), [load]);

  const list = wallets ?? [];
  const connected = wallet.connected ? wallet.address : null;
  return {
    ok: Boolean(connected && list.some((a) => a === connected)),
    loading: wallets === null,
    wallets: list,
    refetch: load,
  };
}

/** Banner + one-time enrolment control for the master wallet. */
export function MasterWalletGate({ status }: { status: MasterWalletStatus }) {
  const wallet = useWallet();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (status.loading) return null;

  const enroll = async () => {
    if (!wallet.address) return;
    setBusy(true);
    setError(null);
    const { error: err } = await supabase
      .from("admin_wallets")
      .insert({ address: wallet.address, label: "Master wallet" });
    if (err) setError(err.message);
    else status.refetch();
    setBusy(false);
  };

  if (status.wallets.length === 0) {
    return (
      <div className="mt-4 rounded-lg border border-warning/40 bg-warning/10 p-4 text-sm">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <div>
            <div className="font-medium text-foreground">No master wallet enrolled</div>
            <p className="mt-1 text-muted-foreground">
              Admin actions are signed by the master wallet. Connect it and enrol it once — after
              that, every privileged action requires that exact wallet.
            </p>
            {error && <p className="mt-2 text-destructive">{error}</p>}
            <button
              type="button"
              onClick={enroll}
              disabled={!wallet.connected || busy}
              className="mt-3 inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wallet className="h-3.5 w-3.5" />}
              {wallet.connected ? "Enrol connected wallet as master" : "Connect a wallet first"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (status.ok) {
    return (
      <div className="mt-4 flex items-center gap-2 rounded-lg border border-success/40 bg-success/10 p-3 text-sm text-success">
        <ShieldCheck className="h-4 w-4 shrink-0" />
        <span>Master wallet connected · {shortAddr(wallet.address)}</span>
      </div>
    );
  }

  return (
    <div className="mt-4 flex items-start gap-3 rounded-lg border border-warning/40 bg-warning/10 p-4 text-sm">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
      <div>
        <div className="font-medium text-foreground">Master wallet not connected</div>
        <p className="mt-1 text-muted-foreground">
          Privileged actions are locked until the master wallet{" "}
          <span className="font-mono">{shortAddr(status.wallets[0])}</span> is connected in this
          browser.
        </p>
      </div>
    </div>
  );
}
