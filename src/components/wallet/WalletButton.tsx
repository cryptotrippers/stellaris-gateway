import { useEffect, useRef, useState } from "react";
import { Wallet, Check, X, QrCode, Loader2, Copy } from "lucide-react";
import QRCode from "qrcode";
import {
  connectWallet,
  connectWithWalletConnect,
  disconnectWallet,
  isWalletConnectConfigured,
  shortAddr,
  useWallet,
  type WalletProvider,
} from "@/lib/wallet-store";

type BrowserProvider = Exclude<WalletProvider, "WalletConnect">;

const PROVIDERS: { id: WalletProvider; desc: string; color: string }[] = [
  { id: "Lace", desc: "Cardano native wallet by IOG", color: "from-sky-500/20 to-cyan-400/10" },
  { id: "Eternl", desc: "Feature-rich multi-account wallet", color: "from-indigo-500/20 to-blue-400/10" },
  { id: "Nami", desc: "Lightweight browser wallet", color: "from-amber-500/20 to-orange-400/10" },
  { id: "WalletConnect", desc: "Scan QR from any CIP-45 mobile wallet", color: "from-emerald-500/20 to-teal-400/10" },
];

export function WalletButton() {
  const wallet = useWallet();
  const [open, setOpen] = useState(false);
  const [showQR, setShowQR] = useState(false);
  const [wcUri, setWcUri] = useState<string | null>(null);
  const [wcStatus, setWcStatus] = useState<"idle" | "pairing" | "waiting" | "error">("idle");
  const [wcError, setWcError] = useState<string | null>(null);
  const qrCanvas = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!wcUri || !qrCanvas.current) return;
    QRCode.toCanvas(qrCanvas.current, wcUri, { width: 224, margin: 1, color: { dark: "#0f172a", light: "#ffffff" } }).catch(() => {
      /* ignore render error */
    });
  }, [wcUri]);

  async function beginWalletConnect() {
    setWcError(null);
    setShowQR(true);
    if (!isWalletConnectConfigured()) {
      setWcStatus("error");
      setWcError(
        "WalletConnect is not configured. Add VITE_WALLETCONNECT_PROJECT_ID (free at cloud.reown.com) and reload."
      );
      return;
    }
    setWcStatus("pairing");
    try {
      const handle = await connectWithWalletConnect("preprod");
      setWcUri(handle.uri);
      setWcStatus("waiting");
      await handle.approval;
      setOpen(false);
      setShowQR(false);
      setWcUri(null);
      setWcStatus("idle");
    } catch (e) {
      setWcStatus("error");
      setWcError((e as Error).message);
    }
  }

  function closeQr() {
    setShowQR(false);
    setWcUri(null);
    setWcStatus("idle");
    setWcError(null);
  }

  if (wallet.connected) {
    return (
      <div className="relative">
        <button
          onClick={() => setOpen(v => !v)}
          className="flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-1.5 text-sm font-medium hover:bg-secondary transition-colors"
        >
          <span className="h-2 w-2 rounded-full bg-success" />
          <span className="hidden sm:inline text-foreground">{shortAddr(wallet.address)}</span>
          <span className="sm:hidden text-foreground">{wallet.provider}</span>
        </button>
        {open && (
          <div className="absolute right-0 mt-2 w-72 rounded-2xl border border-border bg-popover p-4 shadow-elevated">
            <div className="text-[10px] uppercase tracking-widest text-muted-foreground">Connected · {wallet.provider}</div>
            <div className="mt-1 text-xs font-mono text-foreground break-all">{wallet.address}</div>
            <div className="mt-3 rounded-xl bg-secondary/60 p-3">
              <div className="text-[10px] uppercase tracking-widest text-muted-foreground">Balance</div>
              <div className="number-display text-xl font-semibold text-foreground">₳ {wallet.balanceAda.toLocaleString()}</div>
            </div>
            <button
              onClick={() => { void disconnectWallet(); setOpen(false); }}
              className="mt-3 w-full rounded-lg border border-border py-2 text-sm font-medium text-foreground hover:bg-secondary"
            >
              Disconnect
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-2 rounded-full bg-gradient-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-glow transition-transform hover:-translate-y-0.5"
      >
        <Wallet className="h-4 w-4" />
        Connect Wallet
      </button>

      {open && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-foreground/30 backdrop-blur-sm p-4" onClick={() => { setOpen(false); closeQr(); }}>
          <div
            onClick={e => e.stopPropagation()}
            className="w-full max-w-md rounded-3xl border border-border bg-surface p-6 shadow-elevated"
          >
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-lg font-semibold text-foreground">Connect a wallet</h3>
                <p className="mt-1 text-sm text-muted-foreground">Cardano-native. ZK-verified. Non-custodial.</p>
              </div>
              <button onClick={() => { setOpen(false); closeQr(); }} className="rounded-full p-1 hover:bg-secondary">
                <X className="h-4 w-4" />
              </button>
            </div>

            {showQR ? (
              <div className="mt-6 flex flex-col items-center">
                <div className="relative grid h-56 w-56 place-items-center rounded-2xl border border-border bg-white overflow-hidden">
                  {wcStatus === "pairing" && (
                    <div className="flex flex-col items-center gap-2 text-muted-foreground">
                      <Loader2 className="h-6 w-6 animate-spin" />
                      <span className="text-xs">Requesting pairing…</span>
                    </div>
                  )}
                  {wcStatus === "waiting" && <canvas ref={qrCanvas} className="h-56 w-56" />}
                  {wcStatus === "error" && (
                    <div className="p-4 text-center text-xs text-destructive">{wcError}</div>
                  )}
                </div>

                {wcStatus === "waiting" && (
                  <>
                    <p className="mt-3 text-xs text-muted-foreground text-center">
                      Scan with a CIP-45 wallet (Eternl mobile, Vespr, etc.)
                    </p>
                    <button
                      onClick={() => { if (wcUri) void navigator.clipboard.writeText(wcUri); }}
                      className="mt-2 inline-flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground"
                    >
                      <Copy className="h-3 w-3" /> Copy pairing URI
                    </button>
                  </>
                )}
                <button onClick={closeQr} className="mt-4 text-xs text-muted-foreground hover:text-foreground">
                  Back
                </button>
              </div>
            ) : (
              <div className="mt-5 grid gap-2">
                {PROVIDERS.map(p => (
                  <button
                    key={p.id}
                    onClick={() => {
                      if (p.id === "WalletConnect") { void beginWalletConnect(); return; }
                      void connectWallet(p.id as BrowserProvider);
                      setOpen(false);
                    }}
                    className={`group flex items-center gap-3 rounded-xl border border-border bg-gradient-to-br ${p.color} p-3 text-left transition-colors hover:border-primary/40`}
                  >
                    <div className="grid h-10 w-10 place-items-center rounded-lg bg-surface border border-border font-semibold text-foreground">
                      {p.id === "WalletConnect" ? <QrCode className="h-5 w-5" /> : p.id[0]}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-foreground">{p.id}</div>
                      <div className="truncate text-xs text-muted-foreground">{p.desc}</div>
                    </div>
                    <Check className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100" />
                  </button>
                ))}
              </div>
            )}

            <div className="mt-5 flex items-center gap-2 rounded-lg bg-secondary/60 px-3 py-2 text-[11px] text-muted-foreground">
              <span className="h-1.5 w-1.5 rounded-full bg-accent" />
              Hardware wallets supported: Ledger, Trezor, Yubikey
            </div>
          </div>
        </div>
      )}
    </>
  );
}
