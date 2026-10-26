import { createServerFn } from "@tanstack/react-start";
import { type StripeEnv, createStripeClient, getStripeErrorMessage } from "@/lib/stripe.server";

type CheckoutSessionResult = { clientSecret: string } | { error: string };

async function resolveOrCreateCustomer(
  stripe: ReturnType<typeof createStripeClient>,
  options: { email?: string; userId?: string },
): Promise<string> {
  if (options.userId && !/^[a-zA-Z0-9_-]+$/.test(options.userId)) {
    throw new Error("Invalid userId");
  }
  if (options.userId) {
    const found = await stripe.customers.search({
      query: `metadata['userId']:'${options.userId}'`,
      limit: 1,
    });
    if (found.data.length) return found.data[0].id;
  }
  if (options.email) {
    const existing = await stripe.customers.list({ email: options.email, limit: 1 });
    if (existing.data.length) {
      const customer = existing.data[0];
      if (options.userId && customer.metadata?.userId !== options.userId) {
        await stripe.customers.update(customer.id, {
          metadata: { ...customer.metadata, userId: options.userId },
        });
      }
      return customer.id;
    }
  }
  const created = await stripe.customers.create({
    ...(options.email && { email: options.email }),
    ...(options.userId && { metadata: { userId: options.userId } }),
  });
  return created.id;
}

export const createCheckoutSession = createServerFn({ method: "POST" })
  .inputValidator((data: {
    priceId: string;
    quantity?: number;
    customerEmail?: string;
    userId?: string;
    returnUrl: string;
    environment: StripeEnv;
  }) => {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(data.priceId)) throw new Error("Invalid priceId");
    const quantity = data.quantity ?? 1;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10) {
      throw new Error("Invalid quantity");
    }
    if (typeof data.returnUrl !== "string" || data.returnUrl.length > 500) {
      throw new Error("Invalid return URL");
    }
    // S3: this endpoint is public, so a caller-supplied userId or email is not
    // trusted (it could re-label someone else's Stripe customer). Neither is
    // sent by the app today; both are dropped here.
    return { ...data, quantity, userId: undefined, customerEmail: undefined };
  })
  .handler(async ({ data }): Promise<CheckoutSessionResult> => {
    const { enforceRateLimit, RATE_RULES, clientIp, requestDomain } = await import(
      "./rate-limit.server"
    );
    try {
      await enforceRateLimit(RATE_RULES.checkout, await clientIp());
      // The return URL must come back to this site (no open redirect via Stripe).
      const back = new URL(data.returnUrl);
      if (back.protocol !== "https:" && back.hostname !== "localhost") {
        throw new Error("Invalid return URL");
      }
      if (back.hostname.toLowerCase() !== (await requestDomain())) {
        throw new Error("Invalid return URL");
      }
      const stripe = createStripeClient(data.environment);
      const prices = await stripe.prices.list({ lookup_keys: [data.priceId] });
      if (!prices.data.length) throw new Error("Price not found");
      const stripePrice = prices.data[0];
      const isRecurring = stripePrice.type === "recurring";

      const customerId = (data.customerEmail || data.userId)
        ? await resolveOrCreateCustomer(stripe, {
            email: data.customerEmail,
            userId: data.userId,
          })
        : undefined;

      const session = await stripe.checkout.sessions.create({
        line_items: [{ price: stripePrice.id, quantity: data.quantity || 1 }],
        mode: isRecurring ? "subscription" : "payment",
        ui_mode: "embedded_page",
        return_url: data.returnUrl,
        ...(customerId && { customer: customerId }),
        managed_payments: { enabled: true },
      } as any);

      return { clientSecret: session.client_secret ?? "" };
    } catch (error) {
      return { error: getStripeErrorMessage(error) };
    }
  });
