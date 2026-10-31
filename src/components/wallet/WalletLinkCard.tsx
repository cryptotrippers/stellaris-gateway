import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { withTimeout } from "@/lib/auth-flow.shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Link2, Loader2, ShieldCheck } from "lucide-react";
import { useSupabaseUser } from "@/hooks/useSupabaseUser";
import { signMessageWithConnectedWallet, useWallet } from "@/lib/wallet-store";
import {
  confirmWalletLink,
  getMyLinkedWallets,
  requestWalletNonce,
} from "@/lib/wallet-link.functions";
import { shortenAddress } from "@/lib/address";
import { WalletButton } from "./WalletButton";

/**
 * Prove a wallet belongs to this account by signing a one-time message.
 * Only proven wallets carry governance weight.
 */
export function WalletLinkCard({ compact = false }: { compact?: boolean }) {
  const { user } = useSupabaseUser();
  const wallet = useWallet();
  const qc = useQueryClient();
  const list = useServerFn(getMyLinkedWallets);
  const requestNonce = useServerFn(requestWalletNonce);
  const confirm = useServerFn(confirmWalletLink);
  const [error, setError] = useState<string | null>(null);
  const submitting = useRef(false);

  const linked = useQuery({
    queryKey: ["linked-wallets", user?.id ?? null],
    queryFn: () => list(),
    enabled: Boolean(user),
  });

  const link = useMutation({
    mutationFn: async () => {
      setError(null);
      if (!wallet.addressHex) throw new Error("Connect a browser wallet first.");
      const n = await withTimeout(requestNonce({ data: { addressHex: wallet.addressHex } }));
      const signed = await withTimeout(signMessageWithConnectedWallet(n.messageHex), 60_000);
      return withTimeout(
        confirm({ data: { nonce: n.nonce, signature: signed.signature, key: signed.key } }),
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["linked-wallets"] });
      qc.invalidateQueries({ queryKey: ["governance", "my-weights"] });
    },
    onError: (e: Error) => setError(e.message),
    onSettled: () => {
      submitting.current = false;
    },
  });

  if (!user) return null;
  const wallets = linked.data ?? [];

  return (
    <section className={compact ? "rounded-xl border border-border p-4" : "card-institutional p-5"}>
      <h2 className="flex items-center gap-2 text-sm font-medium text-foreground">
        <ShieldCheck className="h-4 w-4 text-primary" aria-hidden="true" /> Linked wallets
      </h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Your vault positions count for voting only from wallets you have proven are yours. Linking
        asks your wallet to sign a short message. It is not a transaction and costs nothing.
      </p>
      {wallets.length > 0 && (
        <ul className="mt-3 space-y-1 text-xs">
          {wallets.map((w) => (
            <li key={w.payment_key_hash} className="font-mono text-foreground">
              {shortenAddress(w.address)}{" "}
              <span className="font-sans text-muted-foreground">
                · proven {new Date(w.verified_at).toLocaleDateString()}
              </span>
            </li>
          ))}
        </ul>
      )}
      {!wallet.connected || !wallet.addressHex ? (
        <div className="mt-3">
          <WalletButton label={wallet.connected ? "Use a browser wallet to link" : "Connect a wallet to link it"} />
        </div>
      ) : <Button
        type="button"
        onClick={() => {
          if (submitting.current) return;
          submitting.current = true;
          link.mutate();
        }}
        disabled={link.isPending}
        className="mt-3 min-h-11 gap-2 text-xs"
      >
        {link.isPending ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <Link2 className="h-3 w-3" />
        )}
        {wallet.connected
          ? wallet.addressHex
            ? "Link this wallet"
            : "Use a browser wallet to link"
          : "Connect a wallet to link it"}
      </Button>}
      {linked.isError && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          Linked wallets could not be loaded.{" "}
          <Button
            variant="link"
            className="min-h-11 px-0 text-xs"
            onClick={() => void linked.refetch()}
          >
            Retry
          </Button>
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
