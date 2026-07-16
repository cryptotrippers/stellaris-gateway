import { createFileRoute } from "@tanstack/react-router";
import { verifyHmacWebhook, WebhookVerificationError } from "@/lib/webhook-verify";

/**
 * Stripe webhook receiver.
 *
 * Auth posture: PUBLIC route (`/api/public/*` bypasses Lovable's edge auth
 * on published sites). Security relies on Stripe's HMAC-SHA256 signature
 * (`stripe-signature` header) plus timestamp freshness + replay dedupe from
 * `verifyHmacWebhook`. Never add `requireSupabaseAuth` here — Stripe cannot
 * send a session token.
 *
 * The `?env=sandbox|live` query parameter selects which webhook secret to
 * verify against (Lovable provisions both). Any other value is rejected.
 */

type StripeEnv = "sandbox" | "live";

function getWebhookSecret(env: StripeEnv): string {
  const name = env === "sandbox" ? "PAYMENTS_SANDBOX_WEBHOOK_SECRET" : "PAYMENTS_LIVE_WEBHOOK_SECRET";
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

interface StripeEvent {
  id: string;
  type: string;
  data: { object: unknown };
  livemode?: boolean;
}

export const Route = createFileRoute("/api/public/payments/webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const rawEnv = new URL(request.url).searchParams.get("env");
        if (rawEnv !== "sandbox" && rawEnv !== "live") {
          console.error("Stripe webhook: invalid or missing ?env=", rawEnv);
          return new Response("Invalid env", { status: 400 });
        }
        const env: StripeEnv = rawEnv;

        const rawBody = await request.text();

        // Peek at the event id BEFORE cryptographic verification so we can
        // key replay detection on the provider's stable event id. This is
        // an untrusted read — verification below still runs on rawBody.
        let peekedEventId: string | null = null;
        try {
          const peek = JSON.parse(rawBody) as { id?: string };
          if (typeof peek.id === "string") peekedEventId = peek.id;
        } catch {
          /* body might not be JSON in a malformed request; verifier will reject */
        }

        try {
          await verifyHmacWebhook({
            signatureHeader: request.headers.get("stripe-signature"),
            rawBody,
            secret: getWebhookSecret(env),
            eventId: peekedEventId,
          });
        } catch (e) {
          const err = e as WebhookVerificationError;
          console.warn(`Stripe webhook rejected [${err.code ?? "error"}]: ${err.message}`);
          // Stripe treats 4xx as a permanent failure and stops retrying.
          return new Response("Signature verification failed", { status: 400 });
        }

        const event = JSON.parse(rawBody) as StripeEvent;
        console.log(`Stripe webhook verified: ${event.type} (${event.id}) env=${env}`);

        // NOTE: Persistence hook. Enable Lovable Cloud + create the
        // `subscriptions` table (see `stripe-webhooks` knowledge) to
        // upsert subscription state here. Keeping this handler intentionally
        // side-effect free until then so verified events return 200 quickly
        // and Stripe stops retrying.
        switch (event.type) {
          case "customer.subscription.created":
          case "customer.subscription.updated":
          case "customer.subscription.deleted":
          case "checkout.session.completed":
          case "invoice.payment_succeeded":
          case "invoice.payment_failed":
            break;
          default:
            // Unhandled types are still valid — return 200 so Stripe drops them.
            break;
        }

        return Response.json({ received: true });
      },
    },
  },
});
