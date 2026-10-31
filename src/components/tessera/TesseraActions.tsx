/**
 * Tessera actions for the connected wallet (build guide P5.6): Stake, Unstake
 * (Tickets and Claim) and Redeem (Instant or Request), on Preprod.
 *
 * Figures come from the live snapshot (`getTesseraLive`, shared with the
 * /tessera dashboard). Every button builds the transaction in the browser
 * (`tessera-tx.ts`), which re-reads the chain and re-quotes; the confirm dialog
 * then shows what will actually leave the wallet before it signs.
 */
import { useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Coins, Loader2, Timer } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TxConfirmationBadge } from "@/components/vault/TxConfirmationBadge";
import { WalletButton } from "@/components/wallet/WalletButton";
import { useWallet } from "@/lib/wallet-store";
import { getTesseraLive } from "@/lib/tessera-live.functions";
import type { TesseraLive } from "@/lib/tessera-live.shared";
import { classifyTesseraError } from "@/lib/tessera-tx";
import {
  REQUEST_MIN_MINUTES,
  amountProblem,
  formatUnits,
  instantRoom,
  parseAmount,
  payableAfterIfNow,
  quoteStake,
  quoteUnstake,
  requestMinutesLeft,
  requestsOf,
  ticketsOf,
} from "@/lib/tessera-ui.shared";
import { TESSERA_PREPROD } from "@/lib/tessera-preprod";
import type { TesseraAction } from "@/lib/tessera-session";

export const TESSERA_LIVE_KEY = ["tessera", "live", TESSERA_PREPROD.label] as const;

const when = (ms: number) =>
  new Date(ms).toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

/** Run one action: busy state, the hash with its confirmation badge, or a readable error. */
function useAction() {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ txHash: string; label: string } | null>(null);
  const [error, setError] = useState<{ kind: string; message: string } | null>(null);
  async function run(label: string, action: TesseraAction) {
    setBusy(label);
    setError(null);
    setResult(null);
    try {
      const { runTesseraAction } = await import("@/lib/tessera-session");
      const r = await runTesseraAction(action);
      setResult({ txHash: r.txHash, label });
      void qc.invalidateQueries({ queryKey: ["tessera"] });
    } catch (e) {
      setError(classifyTesseraError(e));
    } finally {
      setBusy(null);
    }
  }
  return { busy, result, error, run };
}

function Outcome({ a }: { a: ReturnType<typeof useAction> }) {
  return (
    <>
      {a.error && (
        <div
          role="alert"
          className={`mt-3 flex items-start gap-2 rounded-lg border p-3 text-xs ${
            a.error.kind === "declined"
              ? "border-border bg-secondary/50 text-muted-foreground"
              : "border-destructive/40 bg-destructive/5 text-destructive"
          }`}
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {a.error.message}
        </div>
      )}
      {a.result && (
        <div className="mt-3 text-xs text-muted-foreground" role="status">
          {a.result.label} submitted ·{" "}
          <a
            className="font-mono text-primary hover:underline"
            href={`${TESSERA_PREPROD.explorer}/transaction/${a.result.txHash}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            {a.result.txHash.slice(0, 10)}…
          </a>
          <div>
            <TxConfirmationBadge txHash={a.result.txHash} />
          </div>
        </div>
      )}
    </>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium text-foreground">{children}</dd>
    </div>
  );
}

function AmountInput(props: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  max?: bigint | null;
}) {
  return (
    <div>
      <label className="text-sm font-medium" htmlFor={props.id}>
        {props.label}
      </label>
      <div className="mt-2 flex gap-2">
        <input
          id={props.id}
          inputMode="decimal"
          value={props.value}
          onChange={(e) => props.onChange(e.target.value)}
          placeholder="0.00"
          className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm"
        />
        {props.max != null && props.max > 0n && (
          <button
            type="button"
            onClick={() => props.onChange(formatUnits(props.max!).replace(/,/g, ""))}
            className="min-h-11 min-w-11 rounded-lg border border-border px-3 text-xs"
          >
            Max
          </button>
        )}
      </div>
    </div>
  );
}

function Submit(props: {
  disabled: boolean;
  busy: boolean;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={props.disabled || props.busy}
      onClick={props.onClick}
      className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-primary px-4 py-3 text-sm font-semibold text-primary-foreground disabled:opacity-50"
    >
      {props.busy && <Loader2 className="h-4 w-4 animate-spin" />}
      {props.children}
    </button>
  );
}

export function TesseraActions() {
  const wallet = useWallet();
  const live = useQuery({
    queryKey: TESSERA_LIVE_KEY,
    queryFn: () => getTesseraLive(),
    refetchInterval: 60_000,
    retry: false,
  });
  const balances = useQuery({
    queryKey: ["tessera", "balances", wallet.addressHex],
    enabled: wallet.connected,
    retry: 0,
    queryFn: async () => (await import("@/lib/tessera-session")).loadWalletBalances(),
  });

  if (live.isLoading)
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Reading Tessera from Cardano Preprod…
      </p>
    );
  if (live.isError || !live.data)
    return (
      <p className="text-sm text-destructive">
        Couldn't read Tessera from the chain right now. {(live.error as Error | null)?.message}
      </p>
    );

  const L = live.data;
  return (
    <div className="space-y-6">
      <LiveFigures live={L} />
      {!wallet.connected ? (
        <div className="card-institutional flex flex-wrap items-center justify-between gap-3 p-5">
          <p className="text-sm text-muted-foreground">
            Connect a wallet set to <strong>Preprod</strong> to stake, unstake or redeem test TSRA.
          </p>
          <WalletButton />
        </div>
      ) : (
        <div className="card-institutional p-5">
          <div className="mb-4 flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
            {balances.isLoading && (
              <span className="inline-flex items-center gap-1">
                <Loader2 className="h-3 w-3 animate-spin" /> Reading your wallet…
              </span>
            )}
            {balances.isError && (
              <span className="text-destructive">{(balances.error as Error).message}</span>
            )}
            {balances.data && (
              <>
                <span>TSRA {formatUnits(balances.data.tsra, 2)}</span>
                <span>sTSRA {formatUnits(balances.data.stsra, 2)}</span>
                <span>tUSD {formatUnits(balances.data.tusd, 2)}</span>
              </>
            )}
          </div>
          <Tabs defaultValue="stake">
            <TabsList>
              <TabsTrigger value="stake">Stake</TabsTrigger>
              <TabsTrigger value="unstake">Unstake</TabsTrigger>
              <TabsTrigger value="redeem">Redeem</TabsTrigger>
            </TabsList>
            <TabsContent value="stake">
              <StakeTab live={L} tsra={balances.data?.tsra ?? null} />
            </TabsContent>
            <TabsContent value="unstake">
              <UnstakeTab
                live={L}
                stsra={balances.data?.stsra ?? null}
                address={balances.data?.address ?? null}
              />
            </TabsContent>
            <TabsContent value="redeem">
              <RedeemTab
                live={L}
                tsra={balances.data?.tsra ?? null}
                keyHash={balances.data?.keyHash ?? null}
              />
            </TabsContent>
          </Tabs>
        </div>
      )}
    </div>
  );
}

function LiveFigures({ live }: { live: TesseraLive }) {
  const v = live.vault;
  const vesting = BigInt(v.vestShort) > 0n && v.vestUntil > Date.now();
  const stat = (label: string, value: string) => (
    <div className="rounded-md border border-border/60 p-3">
      <div className="text-[10px] uppercase tracking-widest text-muted-foreground">{label}</div>
      <div className="mt-1 text-sm text-foreground">{value}</div>
    </div>
  );
  return (
    <div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {stat("Price", `${formatUnits(v.priceE6, 4)} TSRA per sTSRA`)}
        {stat("Staked (short tier)", `${formatUnits(v.shortAssets, 0)} TSRA`)}
        {stat("Cooldown", `${Math.round(v.bounds.shortCooldownMs / 86_400_000)} days`)}
        {stat("Yield vesting", vesting ? `until ${when(v.vestUntil)}` : "none right now")}
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground">
        Read from Cardano Preprod at {new Date(live.fetchedAt).toLocaleTimeString()}. The price
        rises only as reported yield vests; it is not a promised rate.
      </p>
    </div>
  );
}

function StakeTab({ live, tsra }: { live: TesseraLive; tsra: bigint | null }) {
  const [text, setText] = useState("");
  const a = useAction();
  const amount = parseAmount(text);
  const problem = text ? amountProblem(amount, tsra, 10_000_000n) : null;
  const get = amount ? quoteStake(amount, live.vault.priceE6) : 0n;
  return (
    <div className="mt-4 space-y-3">
      <AmountInput
        id="stake-amt"
        label="Amount (TSRA)"
        value={text}
        onChange={setText}
        max={tsra}
      />
      {problem && <p className="text-xs text-destructive">{problem}</p>}
      {amount && !problem && (
        <dl className="space-y-1 rounded-lg border border-border/60 p-3">
          <Row label="You get about">{formatUnits(get, 4)} sTSRA</Row>
          <Row label="To unstake later">
            Ticket, then {Math.round(live.vault.bounds.shortCooldownMs / 86_400_000)} days
          </Row>
        </dl>
      )}
      <Submit
        disabled={!amount || !!problem}
        busy={a.busy === "Stake"}
        onClick={() => void a.run("Stake", { kind: "stake", amount: amount! })}
      >
        <Coins className="h-4 w-4" /> Stake
      </Submit>
      <Outcome a={a} />
    </div>
  );
}

function UnstakeTab(props: { live: TesseraLive; stsra: bigint | null; address: string | null }) {
  const [text, setText] = useState("");
  const a = useAction();
  const claim = useAction();
  const shares = parseAmount(text);
  const problem = text ? amountProblem(shares, props.stsra) : null;
  const ticket = shares ? quoteUnstake(shares, props.live.vault.priceE6) : 0n;
  const cooldown = props.live.vault.bounds.shortCooldownMs;
  const mine = ticketsOf(props.live, props.address, Date.now());
  return (
    <div className="mt-4 space-y-3">
      <AmountInput
        id="unstake-amt"
        label="Amount (sTSRA)"
        value={text}
        onChange={setText}
        max={props.stsra}
      />
      {problem && <p className="text-xs text-destructive">{problem}</p>}
      {shares && !problem && (
        <dl className="space-y-1 rounded-lg border border-border/60 p-3">
          <Row label="Ticket worth about">{formatUnits(ticket, 4)} TSRA</Row>
          <Row label="Claimable from about">{when(Date.now() + 3_600_000 + cooldown)}</Row>
        </dl>
      )}
      <p className="text-xs text-muted-foreground">
        During the cooldown a Ticket earns no yield but still shares in any reported loss until you
        claim it.
      </p>
      <Submit
        disabled={!shares || !!problem}
        busy={a.busy === "Unstake"}
        onClick={() => void a.run("Unstake", { kind: "unstake", shares: shares! })}
      >
        <Timer className="h-4 w-4" /> Request unstake
      </Submit>
      <Outcome a={a} />

      <h3 className="pt-4 text-sm font-semibold text-foreground">Your Tickets</h3>
      {mine.length === 0 ? (
        <p className="text-xs text-muted-foreground">No open Tickets.</p>
      ) : (
        <ul className="divide-y divide-border/60 text-sm">
          {mine.map((t) => (
            <li key={t.utxo} className="flex items-center justify-between gap-3 py-2">
              <span>
                {formatUnits(t.value, 4)} TSRA ·{" "}
                <span className="text-muted-foreground">
                  {t.claimable ? "ready to claim" : `claimable ${when(t.claimAfter + 120_000)}`}
                </span>
              </span>
              <button
                type="button"
                disabled={!t.claimable || claim.busy !== null}
                onClick={() => void claim.run("Claim", { kind: "claim", ticket: t.utxo })}
                className="rounded-lg border border-border px-3 py-1.5 text-xs disabled:opacity-50"
              >
                {claim.busy ? "Claiming…" : "Claim"}
              </button>
            </li>
          ))}
        </ul>
      )}
      <Outcome a={claim} />
    </div>
  );
}

function RedeemTab(props: { live: TesseraLive; tsra: bigint | null; keyHash: string | null }) {
  const [text, setText] = useState("");
  const a = useAction();
  const now = Date.now();
  const qty = parseAmount(text);
  const room = instantRoom(props.live, now);
  const minReq = BigInt(props.live.queue.config.minRequest);
  const minutes = requestMinutesLeft(now);
  const problem = text ? amountProblem(qty, props.tsra) : null;
  const instantOk = !!qty && !problem && qty <= room;
  const requestOk = !!qty && !problem && qty >= minReq && minutes >= REQUEST_MIN_MINUTES;
  const mine = requestsOf(props.live, props.keyHash, now);
  return (
    <div className="mt-4 space-y-3">
      <AmountInput
        id="redeem-amt"
        label="Amount (TSRA)"
        value={text}
        onChange={setText}
        max={props.tsra}
      />
      {problem && <p className="text-xs text-destructive">{problem}</p>}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-border/60 p-3">
          <div className="text-sm font-semibold">Instant</div>
          <p className="mt-1 text-xs text-muted-foreground">
            tUSD now, 1:1. Up to {formatUnits(room, 0)} TSRA right now (daily and monthly limits).
          </p>
          <Submit
            disabled={!instantOk}
            busy={a.busy === "Instant"}
            onClick={() => void a.run("Instant", { kind: "instant", qty: qty! })}
          >
            Swap now
          </Submit>
        </div>
        <div className="rounded-lg border border-border/60 p-3">
          <div className="text-sm font-semibold">Request</div>
          <p className="mt-1 text-xs text-muted-foreground">
            tUSD 1:1, paid from {when(payableAfterIfNow(props.live, now))}. Minimum{" "}
            {formatUnits(minReq, 0)} TSRA.
            {minutes < REQUEST_MIN_MINUTES && " Requests reopen after midnight UTC (11:00 Sydney)."}
          </p>
          <Submit
            disabled={!requestOk}
            busy={a.busy === "Request"}
            onClick={() => void a.run("Request", { kind: "request", qty: qty! })}
          >
            Queue a Request
          </Submit>
        </div>
      </div>
      <Outcome a={a} />

      <h3 className="pt-4 text-sm font-semibold text-foreground">Your Requests</h3>
      {mine.length === 0 ? (
        <p className="text-xs text-muted-foreground">No open Requests.</p>
      ) : (
        <ul className="divide-y divide-border/60 text-sm">
          {mine.map((r) => (
            <li key={r.utxo} className="flex justify-between gap-3 py-2">
              <span>{formatUnits(r.qty, 2)} TSRA</span>
              <span className="text-muted-foreground">
                {r.payable
                  ? "payable — waiting for a keeper"
                  : `payable from ${when(r.payableAfter)}`}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">
        A queued Request can't be cancelled on this test deployment (a known contract issue, fixed
        in the next one); it is paid out after its date instead.
      </p>
    </div>
  );
}
