import { useState } from "react";
import { HelpCircle, X, ExternalLink } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { APP_NETWORK, networkNameFromId } from "@/lib/network";
import { useWallet } from "@/lib/wallet-store";

/**
 * "How to switch network" help modal. Rendered inline next to a network
 * mismatch error so users can follow provider-specific steps to move their
 * wallet onto the network the app is pointed at.
 */
export function NetworkSwitchHelp({ compact = false }: { compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const wallet = useWallet();

  const appName = APP_NETWORK === "mainnet" ? "Mainnet" : "Preprod testnet";
  const walletName = networkNameFromId(wallet.networkId);
  const provider = wallet.provider ?? "your wallet";

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={
          compact
            ? "inline-flex items-center gap-1 text-[11px] font-semibold text-primary hover:underline"
            : "mt-2 inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline"
        }
      >
        <HelpCircle className="h-3.5 w-3.5" />
        How to switch network
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Switch your wallet to {appName}</DialogTitle>
            <DialogDescription>
              This app is pointed at <strong>{appName}</strong>, but {provider} is on{" "}
              <strong>{walletName}</strong>. Follow the steps for your wallet, then reconnect from the top bar.
            </DialogDescription>
          </DialogHeader>

          <ol className="mt-2 space-y-3 text-sm text-foreground">
            <Step n={1} title="Open your wallet extension">
              Click the {provider} icon in your browser toolbar to open the popup.
            </Step>
            <Step n={2} title={`Find the network selector for ${provider}`}>
              <ProviderTips provider={provider} target={appName} />
            </Step>
            <Step n={3} title={`Select ${appName}`}>
              Choose <strong>{appName}</strong> from the network list. Your wallet may reload and show a
              different address — that's expected, testnet and mainnet use separate address sets.
            </Step>
            <Step n={4} title="Reconnect on this page">
              Come back here, click <strong>Disconnect</strong> in the top bar, then <strong>Connect Wallet</strong>{" "}
              again and pick the same wallet. The network badge should now match.
            </Step>
          </ol>

          {APP_NETWORK === "preprod" && (
            <div className="mt-4 rounded-lg border border-border bg-secondary/60 p-3 text-xs text-muted-foreground">
              Need test ADA?{" "}
              <a
                href="https://docs.cardano.org/cardano-testnets/tools/faucet/"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 font-semibold text-primary hover:underline"
              >
                Preprod faucet <ExternalLink className="h-3 w-3" />
              </a>
              {" "}gives 10,000 tADA per request.
            </div>
          )}

          <button
            type="button"
            onClick={() => setOpen(false)}
            className="absolute right-3 top-3 grid h-7 w-7 place-items-center rounded-full text-muted-foreground hover:bg-secondary"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </DialogContent>
      </Dialog>
    </>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-primary/10 text-[11px] font-bold text-primary">
        {n}
      </span>
      <div>
        <div className="text-sm font-semibold">{title}</div>
        <div className="mt-0.5 text-xs text-muted-foreground">{children}</div>
      </div>
    </li>
  );
}

function ProviderTips({ provider, target }: { provider: string; target: string }) {
  const p = provider.toLowerCase();
  if (p.includes("lace"))
    return <>Open the <strong>≡ menu</strong> → <strong>Settings</strong> → <strong>Network</strong>, then choose {target}.</>;
  if (p.includes("eternl"))
    return <>Click the network dropdown at the top of the Eternl popup (labeled <strong>Mainnet</strong> or <strong>Preprod</strong>) and switch to {target}. You may need to enable Testnet Mode under Settings → General first.</>;
  if (p.includes("nami"))
    return <>Open <strong>⋯ menu</strong> → <strong>Settings</strong> → <strong>Network</strong> and choose {target}.</>;
  if (p.includes("typhon"))
    return <>Click the network chip in the top-right of the Typhon popup and switch to {target}.</>;
  if (p.includes("flint"))
    return <>Open <strong>Settings</strong> → <strong>Network</strong> and choose {target}.</>;
  if (p.includes("yoroi"))
    return <>Yoroi installs one wallet per network. Add or open a wallet created on <strong>{target}</strong> and set it as active.</>;
  if (p.includes("gero"))
    return <>Open <strong>Settings</strong> → <strong>Network</strong> and choose {target}.</>;
  if (p.includes("vespr"))
    return <>Open <strong>Settings</strong> → <strong>Network</strong> and choose {target}.</>;
  if (p.includes("walletconnect"))
    return <>Disconnect the WalletConnect session, switch the network inside your mobile wallet, then re-scan the QR from the top bar.</>;
  return <>Open your wallet's settings and look for a <strong>Network</strong> option. Choose {target}.</>;
}
