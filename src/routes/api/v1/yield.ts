import { createFileRoute } from "@tanstack/react-router";
import type {
  BfAddressTx,
  VaultStateDatum,
} from "@/lib/yield-chain-decode";
import {
  change24hPct,
  sumAccrualsSince,
  trailingWindowStart,
  weightedApy,
  type YieldFeed,
  type YieldFeedVault,
} from "@/lib/yield-dashboard.shared";


/**
 * Live yield feed for the sUSDr dashboard.
 *
 * Read-only aggregate over every registered vault: TVL, realised APY and
 * accrual windows are decoded from the vault state UTxOs and their
 * transaction history. Figures with no on-chain or attested source are
 * returned as null with a reason — never filled in.
 */
export const Route = createFileRoute("/api/v1/yield")({
  server: {
    handlers: {
      GET: async () => {
        try {
          const { bfGet } = await import("@/lib/blockfrost-fetch.server");
          const { supabase } = await import("@/integrations/supabase/client");
          const {
            BECH32_ADDRESS_RE,
            annualisedReturnPct,
            deriveAccruals,
            readStateDatum,
            selectCanonicalState,
            sharePriceOf,
          } = await import("@/lib/yield-chain-decode");
          type StateDatum = VaultStateDatum;


          const { data: rows } = await supabase
            .from("asset_vaults")
            .select("asset_id,script_address,network");

          const now = Date.now();
          const dayStart = trailingWindowStart(now, 1);
          const weekStart = trailingWindowStart(now, 7);
          const vaults: YieldFeedVault[] = [];

          for (const row of rows ?? []) {
            const address = row.script_address;
            if (!BECH32_ADDRESS_RE.test(address)) continue;

            const txs =
              (await bfGet<BfAddressTx[]>(
                `/addresses/${address}/transactions?order=asc&count=50`,
              )) ?? [];

            const points: Array<{ tx: BfAddressTx; state: StateDatum }> = [];
            for (const tx of txs) {
              const detail = await bfGet<{
                outputs: Array<{ address: string; inline_datum: string | null }>;
              }>(`/txs/${tx.tx_hash}/utxos`);
              if (!detail) continue;
              const decoded: Array<{
                txHash: string;
                outputIndex: number;
                state: StateDatum;
              }> = [];
              detail.outputs.forEach((out, index) => {
                if (out.address !== address) return;
                const state = readStateDatum(out.inline_datum);
                if (state) decoded.push({ txHash: tx.tx_hash, outputIndex: index, state });
              });
              const canonical = selectCanonicalState(decoded, (c) => c);

              if (canonical) points.push({ tx, state: canonical.state });
            }


            const accruals = deriveAccruals(points);
            const latest = points[points.length - 1]?.state ?? null;

            vaults.push({
              assetId: row.asset_id,
              address,
              network: row.network,
              totalAssetsLovelace: latest?.totalAssets ?? "0",
              totalShares: latest?.totalShares ?? "0",
              sharePrice: latest ? sharePriceOf(latest) : null,
              epoch: latest?.epoch ?? null,
              apyPct: annualisedReturnPct(accruals),
              accrualCount: accruals.length,
              weeklyYieldLovelace: sumAccrualsSince(accruals, weekStart).toString(),
              dailyYieldLovelace: sumAccrualsSince(accruals, dayStart).toString(),
              lastAccrualBlockTime: accruals[accruals.length - 1]?.blockTime ?? null,
            });
          }

          const tvl = vaults.reduce((t, v) => t + BigInt(v.totalAssetsLovelace), 0n);
          const daily = vaults.reduce((t, v) => t + BigInt(v.dailyYieldLovelace), 0n);
          const weekly = vaults.reduce((t, v) => t + BigInt(v.weeklyYieldLovelace), 0n);

          const feed: YieldFeed = {
            network: vaults[0]?.network ?? "preprod",
            checkedAt: now,
            tvlLovelace: tvl.toString(),
            tvlChange24hPct: change24hPct(tvl, daily),
            apyPct: weightedApy(vaults),
            weeklyYieldLovelace: weekly.toString(),
            vaults,
            // No independent portfolio attestation is wired to these vaults yet,
            // so there is no reserve breakdown to publish.
            reserves: null,
            reservesUnavailableReason:
              "No attested reserve report is connected to these vaults yet. The breakdown appears here once an administrator publishes one.",
            redemption: {
              queueLength: null,
              queuePosition: null,
              daysUntilAvailable: null,
              unavailableReason:
                "The vault settles withdrawals directly on chain, so there is no redemption queue to wait in.",
            },
          };

          return new Response(JSON.stringify(feed), {
            headers: {
              "content-type": "application/json",
              "cache-control": "public, max-age=15",
            },
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown error";
          return new Response(JSON.stringify({ error: message }), {
            status: 503,
            headers: { "content-type": "application/json" },
          });
        }
      },
    },
  },
});
