import { createFileRoute } from "@tanstack/react-router";
import {
  REDEMPTION_WINDOW_DAYS,
  type RedemptionQueueFeed,
} from "@/lib/redemption-queue.shared";

/**
 * Per-wallet redemption queue feed.
 *
 * The sUSDr vault settles withdrawals directly on chain today — there is no
 * queue contract to read, so this returns an empty feed with a reason rather
 * than fabricated queue positions. When a queued redemption mechanism is
 * deployed, entries will be decoded from its state UTxOs here.
 */
export const Route = createFileRoute("/api/v1/yield/user/$address/queue")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const { BECH32_ADDRESS_RE } = await import("@/lib/yield-chain-decode");
        const address = params.address;

        if (!BECH32_ADDRESS_RE.test(address)) {
          return new Response(JSON.stringify({ error: "Invalid address" }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }

        const feed: RedemptionQueueFeed = {
          network: "preprod",
          address,
          checkedAt: Date.now(),
          windowDays: REDEMPTION_WINDOW_DAYS,
          entries: [],
          unavailableReason:
            "The vault settles withdrawals directly on chain, so this wallet has no queued redemptions.",
        };

        return new Response(JSON.stringify(feed), {
          headers: {
            "content-type": "application/json",
            "cache-control": "public, max-age=15",
          },
        });
      },
    },
  },
});
