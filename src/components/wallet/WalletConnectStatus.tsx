import { useEffect, useRef, useState } from "react";
import { Link, QrCode, Loader2, Copy, X, Check, AlertTriangle } from "lucide-react";
import QRCode from "qrcode";
import {
  connectWithWalletConnect,
  disconnectWallet,
  isWalletConnectConfigured,
  shortAddr,
  useWallet,
} from "@/lib/wallet-store";

type WcStatus = "idle" | "pairing" | "waiting" | "error";

/**
 * Compact WalletConnect status pill for the top app bar. Shows one of:
 *  - Not configured (missing env)
 *  - Disconnected → "Connect" opens QR
 *  - Connecting (spinner)
 *  - Connected via WalletConnect → address + Disconnect
 *  - Connected via a browser wallet → shows "WC idle" so the user can also pair a mobile wallet
 */
export function WalletConnectStatus() {
  const wallet = useWallet();
  const configured = isWalletConnectConfigured();
  const isWc = wallet.connected && wallet.provider === "WalletConnect";

  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<WcStatus>("idle");
  const [uri, setUri] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!uri || !canvasRef.current) return;
    QRCode.toCanvas(canvasRef.current, uri, {
      width: 224,
      margin: 1,
      color: { dark: "#0f172a", light: "#ffffff" },
    }).catch(() => {});
  }, [uri]);

  function reset() {
    setStatus("idle");
    setUri(null);
    setError(null);
    setConfirmDisconnect(false);
  }

  async function beginPairing() {
    setError(null);
    if (!configured) {
      setStatus("error");
      setError("WalletConnect is not configured. Set VITE_WALLETCONNECT_PROJECT_ID and reload.");
      return;
    }
    setStatus("pairing");
    try {
      const handle = await connectWithWalletConnect("preprod");
      setUri(handle.uri);
      setStatus("waiting");
      await handle.approval;
      setOpen(false);
      reset();
    } catch (e) {
      setStatus("error");
      setError((e as Error).message);
    }
  }

  // Pill visual state
  const dot = !configured
    ? "bg-warning"
    : isWc
      ? "bg-success"
      : status === "pairing" || status === "waiting"
        ? "bg-accent animate-pulse"
        : "bg-muted-foreground/50";

  const label = !configured
    ? "WC unavailable"
    : isWc
      ? shortAddr(wallet.address) || "WC connected"
      : status === "pairing"
        ? "Pairing…"
        : status === "waiting"
          ? "Waiting for wallet"
          : "WalletConnect";

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(v => !v)}
        aria-label="WalletConnect status"
        className="hidden md:inline-flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-1.5 text-xs font-medium text-foreground hover:bg-secondary transition-colors"
      >
        <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
        <Link className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="max-w-[140px] truncate">{label}</span>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => { setOpen(false); reset(); }} />
          <div className="absolute right-0 z-50 mt-2 w-80 rounded-2xl border border-border bg-popover p-4 shadow-elevated">
            <div className="flex items-start justify-between">
              <div>
                <div className="text-[10px] uppercase tracking-widest text-muted-foreground">WalletConnect</div>
                <div className="mt-0.5 text-sm font-semibold text-foreground">
                  {!configured
                    ? "Not configured"
                    : isWc
                      ? "Session active"
                      : status === "waiting"
                        ? "Awaiting approval"
                        : status === "pairing"
                          ? "Requesting pairing"
                          : "Not connected"}
                </div>
              </div>
              <button
                onClick={() => { setOpen(false); reset(); }}
                className="rounded-full p-1 hover:bg-secondary"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Body */}
            {!configured ? (
              <div className="mt-4 flex items-start gap-2 rounded-lg bg-warning/10 p-3 text-xs text-foreground">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                <span>
                  Set <span className="font-mono">VITE_WALLETCONNECT_PROJECT_ID</span> in your env
                  (free at cloud.reown.com) and reload.
                </span>
              </div>
            ) : isWc ? (
              <>
                {(() => {
                  const isMainnet = wallet.networkId === 1;
                  const isTestnet = wallet.networkId === 0;
                  const netLabel = isMainnet ? "Mainnet" : isTestnet ? "Preprod Testnet" : "Unknown network";
                  const netTone = isMainnet
                    ? "bg-success/15 text-success border-success/30"
                    : isTestnet
                      ? "bg-warning/15 text-warning border-warning/30"
                      : "bg-muted text-muted-foreground border-border";
                  return (
                    <div className="mt-3 flex items-center gap-2">
                      <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${netTone}`}>
                        <span className="h-1.5 w-1.5 rounded-full bg-current" />
                        {netLabel}
                      </span>
                      <span className="text-[10px] text-muted-foreground">
                        networkId {wallet.networkId ?? "—"}
                      </span>
                    </div>
                  );
                })()}
                <div className="mt-3 rounded-xl bg-secondary/60 p-3">
                  <div className="flex items-center justify-between">
                    <div className="text-[10px] uppercase tracking-widest text-muted-foreground">
                      {wallet.address?.startsWith("stake") ? "Stake address" : "Address"}
                    </div>
                    <button
                      onClick={() => { if (wallet.address) void navigator.clipboard.writeText(wallet.address); }}
                      className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
                    >
                      <Copy className="h-3 w-3" /> Copy
                    </button>
                  </div>
                  <div className="mt-1 break-all font-mono text-xs text-foreground">{wallet.address}</div>
                </div>
                {confirmDisconnect ? (
                  <div className="mt-3 rounded-lg border border-destructive/40 bg-destructive/10 p-3">
                    <div className="flex items-start gap-2">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                      <div className="text-xs text-foreground">
                        <div className="font-semibold">Disconnect this wallet?</div>
                        <p className="mt-1 text-muted-foreground">
                          Your WalletConnect session will end. You'll need to scan a new QR to
                          reconnect.
                        </p>
                      </div>
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-2">
                      <button
                        onClick={() => setConfirmDisconnect(false)}
                        className="rounded-lg border border-border py-2 text-xs font-medium text-foreground hover:bg-secondary"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={() => {
                          void disconnectWallet();
                          setConfirmDisconnect(false);
                          setOpen(false);
                        }}
                        className="rounded-lg bg-destructive py-2 text-xs font-semibold text-destructive-foreground hover:opacity-90"
                      >
                        Yes, disconnect
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={() => setConfirmDisconnect(true)}
                    className="mt-3 w-full rounded-lg border border-border py-2 text-sm font-medium text-foreground hover:bg-secondary"
                  >
                    Disconnect
                  </button>
                )}
              </>

            ) : status === "waiting" && uri ? (
              <div className="mt-4 flex flex-col items-center">
                <div className="grid h-56 w-56 place-items-center rounded-2xl border border-border bg-white overflow-hidden">
                  <canvas ref={canvasRef} className="h-56 w-56" />
                </div>
                <p className="mt-3 text-center text-[11px] text-muted-foreground">
                  Scan with a CIP-45 wallet (Eternl mobile, Vespr, …)
                </p>
                <button
                  onClick={() => { if (uri) void navigator.clipboard.writeText(uri); }}
                  className="mt-2 inline-flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground"
                >
                  <Copy className="h-3 w-3" /> Copy pairing URI
                </button>
                <button
                  onClick={reset}
                  className="mt-3 text-xs text-muted-foreground hover:text-foreground"
                >
                  Cancel
                </button>
              </div>
            ) : status === "pairing" ? (
              <div className="mt-4 flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Requesting pairing…
              </div>
            ) : status === "error" ? (
              <>
                <div className="mt-3 rounded-lg bg-destructive/10 p-3 text-xs text-destructive">
                  {error}
                </div>
                <button
                  onClick={beginPairing}
                  className="mt-3 w-full rounded-lg bg-gradient-primary py-2 text-sm font-semibold text-primary-foreground hover:opacity-90"
                >
                  Try again
                </button>
              </>
            ) : (
              <>
                <p className="mt-3 text-xs text-muted-foreground">
                  Pair a Cardano mobile wallet over CIP-45. A QR appears here — scan it with
                  Eternl mobile, Vespr, or any CIP-45 wallet.
                </p>
                {wallet.connected && !isWc && (
                  <div className="mt-3 flex items-start gap-2 rounded-lg bg-secondary/60 p-3 text-[11px] text-muted-foreground">
                    <Check className="mt-0.5 h-3.5 w-3.5 text-success" />
                    <span>
                      Currently connected via {wallet.provider}. Pairing WalletConnect will
                      replace this session.
                    </span>
                  </div>
                )}
                <button
                  onClick={beginPairing}
                  className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-gradient-primary py-2 text-sm font-semibold text-primary-foreground hover:opacity-90"
                >
                  <QrCode className="h-4 w-4" /> Connect via WalletConnect
                </button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
