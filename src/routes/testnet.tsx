import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { Activity, Wallet, ExternalLink, RefreshCw, CheckCircle2, AlertCircle, Copy, Droplet } from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import { Badge } from "@/components/ui/StatusBadge";
import { getBlockfrostHealth, getPreprodTip } from "@/lib/blockfrost.functions";
import { listWallets, type CardanoWalletInfo } from "@/lib/cip30";
import { connectWallet, disconnectWallet, useWallet, shortAddr, type WalletProvider } from "@/lib/wallet-store";

const tipQuery = queryOptions({
  queryKey: ["preprod", "tip"],
  queryFn: () => getPreprodTip(),
  refetchInterval: 20_000,
  staleTime: 15_000,
  retry: 1,
});

const healthQuery = queryOptions({
  queryKey: ["preprod", "blockfrost-health"],
  queryFn: () => getBlockfrostHealth(),
  staleTime: 60_000,
  retry: 0,
});


interface Banner { tone: "destructive" | "warning"; title: string; detail: string; }


export const Route = createFileRoute("/testnet")({
  head: () => ({
    meta: [
      { title: "RealFi Testnet · Cardano Preprod · Stellaris" },
      { name: "description", content: "Live Cardano Preprod (RealFi testnet) chain tip, CIP-30 wallet connection, faucet, and explorer links." },
      { property: "og:title", content: "RealFi Testnet · Cardano Preprod" },
      { property: "og:description", content: "Connect a Cardano wallet on Preprod and follow the live chain tip." },
    ],
  }),
  loader: ({ context }) => Promise.all([
    context.queryClient.ensureQueryData(healthQuery).catch(() => null),
    context.queryClient.ensureQueryData(tipQuery).catch(() => null),
  ]),
  component: TestnetPage,
});


const PROVIDER_LABEL: Record<string, WalletProvider> = {
  lace: "Lace", eternl: "Eternl", nami: "Nami", typhon: "Typhon",
  flint: "Flint", yoroi: "Yoroi", gerowallet: "GeroWallet",
};

function TestnetPage() {
  const tipQ = useQuery(tipQuery);
  const healthQ = useQuery(healthQuery);
  const wallet = useWallet();
  const [wallets, setWallets] = useState<CardanoWalletInfo[]>([]);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => { setWallets(listWallets()); }, []);

  async function handleConnect(w: CardanoWalletInfo) {
    setConnectError(null);
    setPending(w.id);
    const label = PROVIDER_LABEL[w.id] ?? "Lace";
    const r = await connectWallet(label);
    setPending(null);
    if (!r.ok) setConnectError(r.error ?? "Connection failed");
  }

  const wrongNetwork = wallet.connected && wallet.networkId === 1;

  const banners: Banner[] = [];
  const health = healthQ.data;
  if (health && health.status !== "ok") {
    const titleMap: Record<typeof health.status, string> = {
      missing: "Blockfrost is not configured",
      wrong_network: `Blockfrost key is for ${health.detectedNetwork ?? "another network"}, not Preprod`,
      invalid: "Blockfrost rejected the project ID",
      unreachable: "Blockfrost is unreachable",
      ok: "",
    };
    banners.push({
      tone: health.status === "unreachable" ? "warning" : "destructive",
      title: titleMap[health.status],
      detail: health.detail,
    });
  } else if (tipQ.error && (!health || health.status === "ok")) {
    // Health said OK but a live tip fetch still failed — network blip / rate limit.
    banners.push({
      tone: "warning",
      title: "Preprod chain tip unavailable",
      detail: (tipQ.error as Error).message,
    });
  }

  if (wrongNetwork) {
    banners.push({
      tone: "warning",
      title: `${wallet.provider} is on mainnet`,
      detail: "Switch your wallet's network to Preprod (Settings → Network) and reconnect to test against RealFi's testnet.",
    });
  }
  if (connectError) {
    banners.push({ tone: "destructive", title: "Wallet connection failed", detail: connectError });
  }


  return (
    <AppShell>
      <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
        <div>
          <div className="text-[11px] uppercase tracking-[0.22em] text-primary">Testnet</div>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight text-foreground">RealFi · Cardano Preprod</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Live chain tip via Blockfrost and CIP-30 wallet connect. Point Lace / Eternl / Nami / Typhon at Preprod to test.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone={tipQ.data ? "success" : tipQ.error ? "destructive" : "muted"}>
            <Activity className="h-3 w-3" /> Preprod {tipQ.data ? "live" : tipQ.error ? "unreachable" : "…"}
          </Badge>
          <button
            onClick={() => tipQ.refetch()}
            className="inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent"
          >
            <RefreshCw className={`h-3 w-3 ${tipQ.isFetching ? "animate-spin" : ""}`} /> Refresh
          </button>
        </div>
      </div>

      {banners.length > 0 && (
        <div className="mt-4 space-y-2">
          {banners.map((b, i) => (
            <div
              key={i}
              role="alert"
              className={`flex items-start gap-3 rounded-lg border p-3 text-sm ${
                b.tone === "destructive"
                  ? "border-destructive/40 bg-destructive/10 text-destructive"
                  : "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
              }`}
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <div className="flex-1">
                <div className="font-semibold">{b.title}</div>
                <div className="mt-0.5 text-xs opacity-90 break-words">{b.detail}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="mt-6 grid gap-4 lg:grid-cols-[1.4fr_1fr]">

        {/* Chain tip */}
        <div className="card-institutional p-6">
          <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
            <Activity className="h-4 w-4 text-primary" /> Live chain tip
          </h2>
          {tipQ.error && (
            <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
              {(tipQ.error as Error).message}. Check that <code className="font-mono">BLOCKFROST_PREPROD_PROJECT_ID</code> is a valid Preprod project ID.
            </div>
          )}
          {tipQ.data && (
            <dl className="mt-4 grid grid-cols-2 gap-4 md:grid-cols-3">
              <TipStat label="Epoch" value={String(tipQ.data.epoch)} />
              <TipStat label="Slot" value={tipQ.data.slot.toLocaleString()} />
              <TipStat label="Block height" value={tipQ.data.block.toLocaleString()} />
              <TipStat label="Txs in block" value={String(tipQ.data.txCount)} />
              <TipStat label="Epoch slot" value={tipQ.data.epochSlot.toLocaleString()} />
              <TipStat
                label="Active stake"
                value={tipQ.data.activeStakeAda ? `${(tipQ.data.activeStakeAda / 1e6).toFixed(1)}M ₳` : "—"}
              />
              <div className="col-span-2 md:col-span-3">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Block hash</div>
                <div className="mt-1 flex items-center gap-2">
                  <code className="truncate rounded bg-muted px-2 py-1 font-mono text-[11px] text-foreground">{tipQ.data.blockHash}</code>
                  <a
                    href={`https://preprod.cardanoscan.io/block/${tipQ.data.blockHash}`}
                    target="_blank" rel="noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                  >
                    Cardanoscan <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
                <div className="mt-1 text-[10px] text-muted-foreground">
                  Updated {new Date(tipQ.data.fetchedAt).toLocaleTimeString()} · auto-refresh 20s
                </div>
              </div>
            </dl>
          )}
        </div>

        {/* Wallet connect */}
        <div className="card-institutional p-6">
          <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
            <Wallet className="h-4 w-4 text-primary" /> Cardano wallet (CIP-30)
          </h2>

          {wallet.connected ? (
            <div className="mt-4 space-y-3">
              <div className="flex items-center gap-2 text-xs">
                {wrongNetwork ? (
                  <Badge tone="destructive"><AlertCircle className="h-3 w-3" /> Mainnet — switch to Preprod</Badge>
                ) : (
                  <Badge tone="success"><CheckCircle2 className="h-3 w-3" /> {wallet.provider} · {wallet.networkId === 0 ? "Testnet" : "unknown"}</Badge>
                )}
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Address</div>
                <div className="mt-1 flex items-center gap-2">
                  <code className="flex-1 truncate rounded bg-muted px-2 py-1 font-mono text-[11px]">{shortAddr(wallet.address)}</code>
                  {wallet.address && (
                    <button
                      onClick={() => navigator.clipboard.writeText(wallet.address!)}
                      className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                      title="Copy"
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Balance</div>
                <div className="mt-1 font-mono text-lg text-foreground">{wallet.balanceAda.toLocaleString(undefined, { maximumFractionDigits: 6 })} ₳</div>
              </div>
              <button
                onClick={disconnectWallet}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-xs font-medium hover:bg-accent"
              >
                Disconnect
              </button>
            </div>
          ) : (
            <div className="mt-4 space-y-2">
              {wallets.map(w => (
                <button
                  key={w.id}
                  onClick={() => handleConnect(w)}
                  disabled={pending !== null}
                  className="flex w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm transition-colors hover:bg-accent disabled:opacity-50"
                >
                  <span className="flex items-center gap-2">
                    {w.icon ? <img src={w.icon} alt="" className="h-4 w-4" /> : <Wallet className="h-4 w-4 text-muted-foreground" />}
                    <span className="font-medium">{w.name}</span>
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    {pending === w.id ? "Connecting…" : w.installed ? "Connect" : "Not installed"}
                  </span>
                </button>
              ))}
              {connectError && (
                <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">{connectError}</div>
              )}
              <p className="pt-2 text-[11px] text-muted-foreground">
                No wallet installed? Buttons still simulate a Preprod connection for demo purposes.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Testnet resources */}
      <div className="mt-4 card-institutional p-6">
        <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
          <Droplet className="h-4 w-4 text-primary" /> Preprod resources
        </h2>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <ResourceLink title="Faucet" desc="Get free tADA for Preprod" url="https://docs.cardano.org/cardano-testnets/tools/faucet" />
          <ResourceLink title="Cardanoscan Preprod" desc="Explorer for txs, blocks, addresses" url="https://preprod.cardanoscan.io" />
          <ResourceLink title="CExplorer Preprod" desc="Alternate explorer & pool stats" url="https://preprod.cexplorer.io" />
          <ResourceLink title="Blockfrost" desc="REST API — cardano-preprod.blockfrost.io" url="https://blockfrost.io" />
          <ResourceLink title="RealFi (USDr) Testnet" desc="Phase 1 testnet UI" url="https://preprod.realfi.co" />
          <ResourceLink title="Cardano Testnets docs" desc="Preprod / Preview / Midnight" url="https://docs.cardano.org/cardano-testnet/getting-started" />
        </div>
      </div>

      <div className="mt-4 flex items-center justify-between text-xs text-muted-foreground">
        <span>Network magic: <code className="font-mono">1</code> (Preprod)</span>
        <Link to="/developers" className="text-primary hover:underline">API & developer portal →</Link>
      </div>
    </AppShell>
  );
}

function TipStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-1 font-mono text-lg text-foreground">{value}</div>
    </div>
  );
}

function ResourceLink({ title, desc, url }: { title: string; desc: string; url: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="group rounded-lg border border-border bg-card p-3 transition-colors hover:border-primary/40 hover:bg-accent/40"
    >
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-foreground">{title}</span>
        <ExternalLink className="h-3.5 w-3.5 text-muted-foreground group-hover:text-primary" />
      </div>
      <div className="mt-1 text-[11px] text-muted-foreground">{desc}</div>
    </a>
  );
}
