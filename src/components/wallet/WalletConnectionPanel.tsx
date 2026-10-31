import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowRight, Wallet, Loader2, Eye, QrCode, Unplug, CircleAlert } from "lucide-react";
import QRCode from "qrcode";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { listWallets } from "@/lib/cip30";
import { cancelWalletConnection, connectWallet, connectWithWalletConnect, disconnectWallet, clearViewer, setViewerAddress, useWallet, isWalletConnectConfigured, type WalletProvider } from "@/lib/wallet-store";
import type { PairingHandle } from "@/lib/walletconnect";

const PROVIDERS = ["Lace", "Eternl", "Nami", "Typhon", "Yoroi", "Flint", "Vespr", "GeroWallet"] as const;
export function WalletConnectionPanel({ onConnected }: { onConnected?: () => void }) {
  const wallet = useWallet();
  const [installed, setInstalled] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [uri, setUri] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [address, setAddress] = useState("");
  const [provider, setProvider] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const pairing = useRef<PairingHandle | null>(null);
  const active = useRef(true);
  const request = useRef(0);
  useEffect(() => {
    active.current = true;
    setInstalled(listWallets().filter((w) => w.installed).map((w) => w.name.toLowerCase()));
    return () => {
      active.current = false; request.current++;
      if (pairing.current) void pairing.current.cancel().catch(() => {});
      if (provider) cancelWalletConnection();
    };
    // A single panel owns an attempt; cancellation is also enforced in the store.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  function cancel() {
    request.current++; cancelWalletConnection();
    if (pairing.current) void pairing.current.cancel().catch(() => {});
    pairing.current = null; setUri(null); setQr(null); setProvider(null);
  }
  async function connect(id: Exclude<WalletProvider, "WalletConnect">) {
    if (wallet.connecting) return;
    const current = ++request.current;
    setError(null); setProvider(id);
    try {
      const result = await connectWallet(id);
      if (!active.current || current !== request.current) return;
      if (!result.ok) setError(result.error.message);
      else onConnected?.();
    } catch { if (active.current && current === request.current) setError("Connection failed. Unlock your wallet and try again."); }
    finally { if (active.current && current === request.current) setProvider(null); }
  }
  async function mobile() {
    if (wallet.connecting) return;
    const current = ++request.current;
    setError(null); setProvider("WalletConnect");
    try {
      const handle = await connectWithWalletConnect("preprod");
      if (!active.current || current !== request.current) { await handle.cancel(); return; }
      pairing.current = handle; setUri(handle.uri);
      // Use qrcode's monochrome defaults; never load provider-supplied imagery.
      const image = await QRCode.toDataURL(handle.uri, { width: 240, margin: 2 });
      if (active.current && current === request.current) setQr(image);
      await handle.approval;
      if (!active.current || current !== request.current) return;
      pairing.current = null; setUri(null); setQr(null); onConnected?.();
    } catch (e) {
      if (active.current && current === request.current) { cancel(); setError(e instanceof Error ? e.message : "Pairing failed. Please try again."); }
    } finally { if (active.current && current === request.current) setProvider(null); }
  }
  const notice = error ?? wallet.connectionError;
  return <div className="min-w-0 space-y-5">
    <p className="rounded-md border border-border bg-secondary/50 p-3 text-xs leading-6 text-muted-foreground">Preprod only. Select <strong className="text-foreground">Preprod</strong> in your wallet. Browser wallets report “testnet”; network ID 0 and test addresses alone cannot distinguish Preview from Preprod. Existing transaction checks remain required.</p>
    {notice && <p role="alert" className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"><CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />{notice}</p>}
    {wallet.connected ? <section className="space-y-4">
      <div className="flex items-center gap-2 text-sm font-semibold"><Wallet className="h-5 w-5 text-teal" />Connected · {wallet.provider}</div>
      <p className="break-all font-mono text-xs leading-6">{wallet.address}</p>
      <p className="text-xs leading-6 text-muted-foreground">Connection is not verified account ownership. Linking requires a separate, explicit signed-message challenge.</p>
      <Button onClick={() => void disconnectWallet().catch(() => setError("Disconnected locally. Reconnect if your wallet still shows a session."))} variant="outline" className="min-h-11 w-full"><Unplug />Disconnect wallet</Button>
      <Button asChild variant="link" className="min-h-11 px-0"><Link to="/account">Account & verified wallets <ArrowRight /></Link></Button>
    </section> : <>
      <Tabs defaultValue="connect" onValueChange={cancel}>
        <TabsList className="grid h-12 w-full grid-cols-2"><TabsTrigger value="connect" className="min-h-10"><Wallet className="mr-2 h-4 w-4" />Connect</TabsTrigger><TabsTrigger value="view" className="min-h-10"><Eye className="mr-2 h-4 w-4" />Read-only</TabsTrigger></TabsList>
        <TabsContent value="connect" className="mt-5 space-y-3">
          {provider && <div role="status" className="flex items-center gap-2 text-sm"><Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />{uri ? "Approve the Preprod connection in your mobile wallet." : `Waiting for ${provider}…`}</div>}
          {uri ? <div className="space-y-3 text-center">
            {qr && <img src={qr} width={240} height={240} className="mx-auto max-w-full rounded-md" alt="WalletConnect pairing QR code" />}
            <p className="break-all rounded-md bg-secondary p-3 text-left font-mono text-xs">{uri}</p>
            <Button variant="outline" className="min-h-11" onClick={async () => { try { await navigator.clipboard.writeText(uri); setCopied(true); } catch { setError("Copy is unavailable. Select the pairing address above to copy it manually."); } }}>{copied ? "Copied" : "Copy pairing address"}</Button>
          </div> : <div className="grid grid-cols-2 gap-2">
            {PROVIDERS.map((id) => <Button key={id} variant="outline" disabled={wallet.connecting} onClick={() => void connect(id)} className="h-auto min-h-16 justify-start whitespace-normal px-3 text-left"><span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-secondary font-display text-teal">{id[0]}</span><span className="min-w-0"><span className="block text-xs font-semibold">{id}</span><span className="block text-[10px] font-normal text-muted-foreground">{installed.includes(id.toLowerCase()) ? "Detected" : "Extension needed"}</span></span></Button>)}
            {isWalletConnectConfigured() && <Button variant="outline" className="col-span-2 min-h-12" disabled={wallet.connecting} onClick={() => void mobile()}><QrCode />Mobile · WalletConnect</Button>}
          </div>}
          {wallet.connecting && <Button variant="outline" className="min-h-11 w-full" onClick={cancel}>Cancel connection</Button>}
        </TabsContent>
        <TabsContent value="view" className="mt-5 space-y-4">
          <p className="text-xs leading-6 text-muted-foreground">Viewing an address grants no signing rights or verified ownership. It is stored only on this device.</p>
          <form onSubmit={(event) => { event.preventDefault(); const result = setViewerAddress(address); if (!result.ok) setError(result.error); else { setError(null); onConnected?.(); } }} className="space-y-3">
            <Label htmlFor="wallet-view-address">Payment or stake address</Label><Input id="wallet-view-address" value={address} onChange={(e) => setAddress(e.target.value)} className="h-12 font-mono text-xs" autoComplete="off" spellCheck={false} required />
            <Button type="submit" disabled={!address.trim()} className="min-h-11 w-full"><Eye />View this address</Button>
          </form>
          {wallet.viewerAddress && <><p className="break-all font-mono text-xs">Tracking {wallet.viewerAddress}</p><Button variant="outline" className="min-h-11 w-full" onClick={clearViewer}>Stop tracking</Button></>}
        </TabsContent>
      </Tabs>
      <p className="text-xs leading-6 text-muted-foreground">Connecting requests access to your wallet, not a transaction signature. Never share a recovery phrase or private key.</p>
    </>}
  </div>;
}
