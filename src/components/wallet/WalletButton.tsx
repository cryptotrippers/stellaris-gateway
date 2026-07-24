import { useEffect, useRef, useState } from "react";
import { Wallet, Check, X, QrCode, Loader2, Copy, AlertTriangle, DownloadCloud, Lock, Ban, Eye, ClipboardPaste } from "lucide-react";
import QRCode from "qrcode";
import {
  clearViewer,
  connectWallet,
  connectWithWalletConnect,
  disconnectWallet,
  isWalletConnectConfigured,
  restoreWallet,
  setViewerAddress,
  shortAddr,
  useWallet,
  type WalletProvider,
} from "@/lib/wallet-store";
import type { CIP30Error, CIP30ErrorKind } from "@/lib/cip30";
import { EXPECTED_WALLET_NETWORK_ID, APP_NETWORK } from "@/lib/network";

type BrowserProvider = Exclude<WalletProvider, "WalletConnect">;
type Tab = "connect" | "view";

const PROVIDERS: { id: WalletProvider; desc: string; color: string }[] = [
  { id: "Lace", desc: "Cardano native wallet by IOG", color: "from-sky-500/20 to-cyan-400/10" },
  { id: "Eternl", desc: "Feature-rich multi-account wallet", color: "from-indigo-500/20 to-blue-400/10" },
  { id: "Nami", desc: "Lightweight browser wallet", color: "from-amber-500/20 to-orange-400/10" },
  { id: "Typhon", desc: "Advanced Cardano wallet", color: "from-fuchsia-500/20 to-pink-400/10" },
  { id: "Yoroi", desc: "EMURGO's light wallet", color: "from-blue-500/20 to-indigo-400/10" },
  { id: "Flint", desc: "Multi-chain browser wallet", color: "from-rose-500/20 to-red-400/10" },
  { id: "Vespr", desc: "Mobile-first Cardano wallet", color: "from-violet-500/20 to-purple-400/10" },
  { id: "WalletConnect", desc: "Scan QR from any CIP-45 mobile wallet", color: "from-emerald-500/20 to-teal-400/10" },
];

const ERROR_ICON: Record<CIP30ErrorKind, typeof AlertTriangle> = {
  no_extension: DownloadCloud,
  locked: Lock,
  rejected: Ban,
  unknown: AlertTriangle,
};

const ERROR_TITLE: Record<CIP30ErrorKind, string> = {
  no_extension: "Wallet not installed",
  locked: "Wallet is locked",
  rejected: "Connection rejected",
  unknown: "Connection failed",
};

export function WalletButton() {
  const wallet = useWallet();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("connect");
  const [showQR, setShowQR] = useState(false);
  const [wcUri, setWcUri] = useState<string | null>(null);
  const [wcStatus, setWcStatus] = useState<"idle" | "pairing" | "waiting" | "error">("idle");
  const [wcError, setWcError] = useState<string | null>(null);
  const [connectingId, setConnectingId] = useState<BrowserProvider | null>(null);
  const [connectError, setConnectError] = useState<{ provider: BrowserProvider; err: CIP30Error } | null>(null);
  const [viewerInput, setViewerInput] = useState("");
  const [viewerError, setViewerError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const qrCanvas = useRef<HTMLCanvasElement | null>(null);

  // Silently restore last-used wallet + viewer address on mount (browser-only)
  useEffect(() => { void restoreWallet(); }, []);

  useEffect(() => {
    if (!wcUri || !qrCanvas.current) return;
    QRCode.toCanvas(qrCanvas.current, wcUri, { width: 224, margin: 1, color: { dark: "#0f172a", light: "#ffffff" } }).catch(() => {
      /* ignore render error */
    });
  }, [wcUri]);

  async function handleBrowserConnect(id: BrowserProvider) {
    setConnectError(null);
    setConnectingId(id);
    const res = await connectWallet(id);
    setConnectingId(null);
    if (res.ok) {
      setOpen(false);
    } else {
      setConnectError({ provider: id, err: res.error });
    }
  }

  async function beginWalletConnect() {
    setWcError(null);
    setShowQR(true);
    if (!isWalletConnectConfigured()) {
      setWcStatus("error");
      setWcError("WalletConnect isn't configured yet. Ask an admin to set VITE_WALLETCONNECT_PROJECT_ID.");
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

  function submitViewer() {
    setViewerError(null);
    const res = setViewerAddress(viewerInput);
    if (!res.ok) {
      setViewerError(res.error);
      return;
    }
    if (res.parsed.networkId !== EXPECTED_WALLET_NETWORK_ID) {
      setViewerError(
        `Address is for ${res.parsed.networkId === 1 ? "Mainnet" : "Testnet"} but this app is on ${APP_NETWORK === "mainnet" ? "Mainnet" : "Preprod testnet"}. Tracking anyway — vault UTxOs won't appear until networks match.`,
      );
    }
    setViewerInput("");
    setOpen(false);
  }

  async function pasteFromClipboard() {
    try {
      const text = await navigator.clipboard.readText();
      setViewerInput(text.trim());
    } catch {
      /* clipboard blocked — user can still type */
    }
  }

  function closeModal() {
    setOpen(false);
    setShowQR(false);
    setWcUri(null);
    setWcStatus("idle");
    setWcError(null);
    setConnectError(null);
    setConnectingId(null);
    setViewerError(null);
    setViewerInput("");
  }

  // ---- Signer connected header ---------------------------------------------
  if (wallet.connected) {
    return (
      <div className="relative">
        <button
          onClick={() => setMenuOpen(v => !v)}
          className="flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-1.5 text-sm font-medium hover:bg-secondary transition-colors"
        >
          <span className="h-2 w-2 rounded-full bg-success" />
          <span className="hidden sm:inline text-foreground">{shortAddr(wallet.address)}</span>
          <span className="sm:hidden text-foreground">{wallet.provider}</span>
        </button>
        {menuOpen && (
          <div className="absolute right-0 mt-2 w-72 rounded-2xl border border-border bg-popover p-4 shadow-elevated">
            <div className="text-[10px] uppercase tracking-widest text-muted-foreground">Connected · {wallet.provider}</div>
            <div className="mt-1 text-xs font-mono text-foreground break-all">{wallet.address}</div>
            <div className="mt-3 rounded-xl bg-secondary/60 p-3">
              <div className="text-[10px] uppercase tracking-widest text-muted-foreground">Balance</div>
              <div className="number-display text-xl font-semibold text-foreground">₳ {wallet.balanceAda.toLocaleString()}</div>
            </div>
            <button
              onClick={() => { void disconnectWallet(); setMenuOpen(false); }}
              className="mt-3 w-full rounded-lg border border-border py-2 text-sm font-medium text-foreground hover:bg-secondary"
            >
              Disconnect
            </button>
          </div>
        )}
      </div>
    );
  }

  // ---- Viewer (read-only) header ------------------------------------------
  if (wallet.viewerAddress) {
    return (
      <div className="relative">
        <button
          onClick={() => setMenuOpen(v => !v)}
          className="flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-1.5 text-sm font-medium hover:bg-secondary transition-colors"
        >
          <Eye className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="hidden sm:inline text-foreground">{shortAddr(wallet.viewerAddress)}</span>
          <span className="sm:hidden text-foreground">Read-only</span>
          <span className="rounded-full bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">read-only</span>
        </button>
        {menuOpen && (
          <div className="absolute right-0 mt-2 w-80 rounded-2xl border border-border bg-popover p-4 shadow-elevated">
            <div className="text-[10px] uppercase tracking-widest text-muted-foreground">
              Tracking · {wallet.viewerKind === "stake" ? "Stake address" : "Payment address"}
            </div>
            <div className="mt-1 text-xs font-mono text-foreground break-all">{wallet.viewerAddress}</div>
            <p className="mt-2 text-[11px] text-muted-foreground">
              Read-only view. Deposits, withdrawals, and governance votes require connecting a signing wallet.
            </p>
            <button
              onClick={() => { setMenuOpen(false); setTab("connect"); setOpen(true); }}
              className="mt-3 w-full rounded-lg bg-gradient-primary py-2 text-sm font-semibold text-primary-foreground shadow-glow"
            >
              Connect a signing wallet
            </button>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <button
                onClick={() => { setMenuOpen(false); setTab("view"); setOpen(true); }}
                className="rounded-lg border border-border py-2 text-xs font-medium text-foreground hover:bg-secondary"
              >
                Change address
              </button>
              <button
                onClick={() => { clearViewer(); setMenuOpen(false); }}
                className="rounded-lg border border-border py-2 text-xs font-medium text-foreground hover:bg-secondary"
              >
                Stop tracking
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  const ErrIcon = connectError ? ERROR_ICON[connectError.err.kind] : AlertTriangle;

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
        <div className="fixed inset-0 z-50 grid place-items-center bg-foreground/30 backdrop-blur-sm p-4" onClick={closeModal}>
          <div
            onClick={e => e.stopPropagation()}
            className="w-full max-w-md rounded-3xl border border-border bg-surface p-6 shadow-elevated"
          >
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-lg font-semibold text-foreground">Connect a wallet</h3>
                <p className="mt-1 text-sm text-muted-foreground">Sign transactions, or view any address read-only.</p>
              </div>
              <button onClick={closeModal} className="rounded-full p-1 hover:bg-secondary" aria-label="Close">
                <X className="h-4 w-4" />
              </button>
            </div>

            {!showQR && (
              <div className="mt-5 grid grid-cols-2 gap-1 rounded-xl border border-border bg-secondary/40 p-1 text-xs">
                <button
                  onClick={() => setTab("connect")}
                  className={`rounded-lg px-3 py-2 font-medium transition-colors ${tab === "connect" ? "bg-surface text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
                >
                  <Wallet className="mr-1 inline h-3.5 w-3.5" /> Connect wallet
                </button>
                <button
                  onClick={() => setTab("view")}
                  className={`rounded-lg px-3 py-2 font-medium transition-colors ${tab === "view" ? "bg-surface text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
                >
                  <Eye className="mr-1 inline h-3.5 w-3.5" /> View by address
                </button>
              </div>
            )}

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
                <button onClick={() => { setShowQR(false); setWcUri(null); setWcStatus("idle"); setWcError(null); }} className="mt-4 text-xs text-muted-foreground hover:text-foreground">
                  Back
                </button>
              </div>
            ) : tab === "view" ? (
              <div className="mt-5">
                <label htmlFor="viewer-addr" className="text-xs font-medium text-muted-foreground">
                  Payment or stake address
                </label>
                <div className="mt-1 flex items-stretch gap-1 rounded-xl border border-border bg-surface focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/20">
                  <input
                    id="viewer-addr"
                    value={viewerInput}
                    onChange={e => { setViewerInput(e.target.value); setViewerError(null); }}
                    placeholder="addr1… / addr_test1… / stake1… / stake_test1…"
                    autoComplete="off"
                    spellCheck={false}
                    className="w-full min-w-0 bg-transparent px-3 py-2.5 font-mono text-xs outline-none"
                    onKeyDown={e => { if (e.key === "Enter") submitViewer(); }}
                  />
                  <button
                    type="button"
                    onClick={pasteFromClipboard}
                    className="border-l border-border px-2 text-muted-foreground hover:text-foreground"
                    aria-label="Paste from clipboard"
                  >
                    <ClipboardPaste className="h-4 w-4" />
                  </button>
                </div>
                {viewerError && (
                  <p className="mt-2 text-[11px] text-destructive">{viewerError}</p>
                )}
                <button
                  onClick={submitViewer}
                  disabled={!viewerInput.trim()}
                  className="mt-3 w-full rounded-xl bg-gradient-primary py-2.5 text-sm font-semibold text-primary-foreground shadow-glow disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Track this address
                </button>
                <ul className="mt-4 space-y-1.5 text-[11px] text-muted-foreground">
                  <li>· Read-only — no signatures required.</li>
                  <li>· Stake addresses aggregate every payment address in the wallet.</li>
                  <li>· Saved locally on this device; clear it any time.</li>
                </ul>
              </div>
            ) : (
              <>
                {connectError && (
                  <div className="mt-4 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs">
                    <ErrIcon className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold text-foreground">{ERROR_TITLE[connectError.err.kind]}</div>
                      <p className="mt-0.5 text-muted-foreground">{connectError.err.message}</p>
                      {connectError.err.kind === "no_extension" && (
                        <p className="mt-1 text-muted-foreground">
                          Install {connectError.provider}, then click Connect again.
                        </p>
                      )}
                      <button
                        onClick={() => setConnectError(null)}
                        className="mt-2 text-[11px] font-medium text-primary hover:underline"
                      >
                        Dismiss
                      </button>
                    </div>
                  </div>
                )}
                <div className="mt-5 grid gap-2">
                  {PROVIDERS.map(p => {
                    const isConnecting = connectingId === p.id;
                    return (
                      <button
                        key={p.id}
                        disabled={connectingId !== null}
                        onClick={() => {
                          if (p.id === "WalletConnect") { void beginWalletConnect(); return; }
                          void handleBrowserConnect(p.id as BrowserProvider);
                        }}
                        className={`group flex items-center gap-3 rounded-xl border border-border bg-gradient-to-br ${p.color} p-3 text-left transition-colors hover:border-primary/40 disabled:opacity-60 disabled:cursor-not-allowed`}
                      >
                        <div className="grid h-10 w-10 place-items-center rounded-lg bg-surface border border-border font-semibold text-foreground">
                          {p.id === "WalletConnect" ? <QrCode className="h-5 w-5" /> : p.id[0]}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="font-medium text-foreground">{p.id}</div>
                          <div className="truncate text-xs text-muted-foreground">{p.desc}</div>
                        </div>
                        {isConnecting ? (
                          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                        ) : (
                          <Check className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100" />
                        )}
                      </button>
                    );
                  })}
                </div>
              </>
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
