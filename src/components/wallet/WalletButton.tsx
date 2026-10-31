import { useState } from "react";
import { Wallet, Eye } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { WalletConnectionPanel } from "./WalletConnectionPanel";
import { cancelWalletConnection, shortAddr, useWallet } from "@/lib/wallet-store";

export function WalletButton() {
  const wallet = useWallet();
  const [open, setOpen] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) cancelWalletConnection();
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button
          className="min-h-11 gap-2 px-3"
          variant={wallet.connected ? "outline" : "default"}
          aria-label="Manage wallet connection"
        >
          {wallet.viewerAddress && !wallet.connected ? <Eye /> : <Wallet />}
          <span className="hidden lg:inline">
            {wallet.connected
              ? shortAddr(wallet.address)
              : wallet.viewerAddress
                ? "Read-only"
                : "Connect wallet"}
          </span>
          <span className="lg:hidden">{wallet.connected ? wallet.provider : "Wallet"}</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90dvh] w-[calc(100%-2rem)] max-w-md overflow-y-auto rounded-lg p-5 sm:p-6 [&>button]:min-h-11 [&>button]:min-w-11">
        <DialogHeader className="pr-8 text-left">
          <DialogTitle className="tracking-normal">Your Cardano wallet</DialogTitle>
          <DialogDescription>
            Account login and wallet ownership are separate from connection.
          </DialogDescription>
        </DialogHeader>
        <WalletConnectionPanel onConnected={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}
