import { useState } from "react";
import { Wallet, Check, X, QrCode } from "lucide-react";
import { connectWallet, disconnectWallet, shortAddr, useWallet, type WalletProvider } from "@/lib/wallet-store";

const PROVIDERS: { id: WalletProvider; desc: string; color: string }[] = [
  { id: "Lace", desc: "Cardano native wallet by IOG", color: "from-sky-500/20 to-cyan-400/10" },
  { id: "Eternl", desc: "Feature-rich multi-account wallet", color: "from-indigo-500/20 to-blue-400/10" },
  { id: "Nami", desc: "Lightweight browser wallet", color: "from-amber-500/20 to-orange-400/10" },
  { id: "WalletConnect", desc: "Scan QR from any mobile wallet", color: "from-emerald-500/20 to-teal-400/10" },
];

export function WalletButton() {
  const wallet = useWallet();
  const [open, setOpen] = useState(false);
  const [showQR, setShowQR] = useState(false);

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
              onClick={() => { disconnectWallet(); setOpen(false); }}
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
        <div className="fixed inset-0 z-50 grid place-items-center bg-foreground/30 backdrop-blur-sm p-4" onClick={() => setOpen(false)}>
          <div
            onClick={e => e.stopPropagation()}
            className="w-full max-w-md rounded-3xl border border-border bg-surface p-6 shadow-elevated"
          >
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-lg font-semibold text-foreground">Connect a wallet</h3>
                <p className="mt-1 text-sm text-muted-foreground">Cardano-native. ZK-verified. Non-custodial.</p>
              </div>
              <button onClick={() => setOpen(false)} className="rounded-full p-1 hover:bg-secondary">
                <X className="h-4 w-4" />
              </button>
            </div>

            {showQR ? (
              <div className="mt-6 flex flex-col items-center">
                <div className="grid h-56 w-56 place-items-center rounded-2xl border border-border bg-secondary/40">
                  <QRPreview />
                </div>
                <p className="mt-3 text-xs text-muted-foreground text-center">Scan with any Cardano mobile wallet</p>
                <button onClick={() => { connectWallet("WalletConnect"); setOpen(false); setShowQR(false); }} className="mt-4 w-full rounded-lg bg-primary py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90">
                  Simulate connection
                </button>
                <button onClick={() => setShowQR(false)} className="mt-2 text-xs text-muted-foreground hover:text-foreground">Back</button>
              </div>
            ) : (
              <div className="mt-5 grid gap-2">
                {PROVIDERS.map(p => (
                  <button
                    key={p.id}
                    onClick={() => {
                      if (p.id === "WalletConnect") { setShowQR(true); return; }
                      connectWallet(p.id);
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

function QRPreview() {
  // Deterministic pseudo-QR grid
  const cells = 21;
  return (
    <svg viewBox={`0 0 ${cells} ${cells}`} className="h-44 w-44">
      {Array.from({ length: cells * cells }).map((_, i) => {
        const x = i % cells;
        const y = Math.floor(i / cells);
        const isFinder =
          (x < 7 && y < 7) || (x > cells - 8 && y < 7) || (x < 7 && y > cells - 8);
        const on = isFinder ? ((x === 0 || x === 6 || y === 0 || y === 6) || (x > 1 && x < 5 && y > 1 && y < 5)) : (Math.sin(x * 12.9898 + y * 78.233) * 43758.5453) % 1 > 0.5;
        return on ? <rect key={i} x={x} y={y} width="1" height="1" fill="currentColor" /> : null;
      })}
    </svg>
  );
}
