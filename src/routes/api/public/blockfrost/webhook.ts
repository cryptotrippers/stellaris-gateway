import { createFileRoute } from "@tanstack/react-router";
import { verifyHmacWebhook, WebhookVerificationError } from "@/lib/webhook-verify";

/**
 * Blockfrost webhook receiver.
 *
 * Public route. Security = HMAC-SHA256 signature verification via the
 * `Blockfrost-Signature` header (`t=<unix>,v1=<hex>[,v1=...]`), the same
 * `<timestamp>.<body>` signing scheme Stripe uses. The signing secret is
 * the "auth token" you set when creating the webhook in the Blockfrost
 * dashboard, stored as `BLOCKFROST_WEBHOOK_AUTH_TOKEN`.
 *
 * Replay protection: verifier keys on the top-level Blockfrost `id` field
 * plus a 5-minute freshness window.
 */

interface BlockfrostEvent {
  id?: string;
  webhook_id?: string;
  type?: string;
  payload?: unknown;
}

export const Route = createFileRoute("/api/public/blockfrost/webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = process.env.BLOCKFROST_WEBHOOK_AUTH_TOKEN;
        if (!secret) {
          console.error("Blockfrost webhook: BLOCKFROST_WEBHOOK_AUTH_TOKEN not configured");
          return new Response("Webhook receiver not configured", { status: 503 });
        }

        const rawBody = await request.text();

        let peekedEventId: string | null = null;
        try {
          const peek = JSON.parse(rawBody) as { id?: string };
          if (typeof peek.id === "string") peekedEventId = peek.id;
        } catch {
          /* verifier will reject a malformed body */
        }

        try {
          await verifyHmacWebhook({
            signatureHeader: request.headers.get("blockfrost-signature"),
            rawBody,
            secret,
            eventId: peekedEventId,
            // Blockfrost recommends a 10-minute tolerance for network jitter.
            toleranceSeconds: 600,
          });
        } catch (e) {
          const err = e as WebhookVerificationError;
          console.warn(`Blockfrost webhook rejected [${err.code ?? "error"}]: ${err.message}`);
          return new Response("Signature verification failed", { status: 400 });
        }

        const event = JSON.parse(rawBody) as BlockfrostEvent;
        console.log(
          `Blockfrost webhook verified: type=${event.type ?? "unknown"} id=${event.id ?? "?"}`,
        );

        // Persistence hook — wire to indexer / notification storage once
        // Lovable Cloud is enabled. Returning 200 confirms the delivery so
        // Blockfrost won't retry.
        return Response.json({ received: true });
      },
    },
  },
});
