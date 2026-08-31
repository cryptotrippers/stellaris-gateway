/**
 * Lovable AI Gateway helpers (server-only).
 *
 * Import this module ONLY from server contexts (route handlers, `createServerFn`
 * handlers, or other `.server.ts` modules) — it ships `process.env` reads and
 * AI SDK providers and must never enter the client bundle.
 *
 * Two provider factories:
 * - `createLovableAiGatewayProvider` — chat/completions path
 *   (`@ai-sdk/openai-compatible`), for non-OpenAI vendors such as `google/*`.
 * - `createLovableAiGatewayResponsesProvider` — gateway Responses API
 *   (`@ai-sdk/openai`), for OpenAI models marked ✓ in the catalog
 *   (e.g. the default `openai/gpt-5.6-sol`). Every call on that path must
 *   stream (`streamText`, never `generateText`).
 */
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenAI } from "@ai-sdk/openai";

const LOVABLE_AIG_RUN_ID_HEADER = "X-Lovable-AIG-Run-ID";
const GATEWAY_BASE_URL = "https://ai.gateway.lovable.dev/v1";

/** Read the gateway key inside a request/action boundary. Never at module scope. */
export function getLovableApiKey(): string {
  const key = process.env["LOVABLE_API_KEY"];
  if (!key) throw new Error("Missing LOVABLE_API_KEY. Enable AI for the project to provision it.");
  return key;
}

/**
 * Run-id capture, reusable across providers. Returns a `fetch` wrapper that
 * resends a known run id and captures the one the gateway mints, plus accessors.
 * The Responses provider reuses this — pass `fetch` into createOpenAI.
 */
export function createLovableAiGatewayRunIdFetch(initialRunId?: string) {
  let runId = initialRunId?.trim() || undefined;
  let resolveRunId: (value: string | undefined) => void = () => {};
  let runIdResolved = false;
  const runIdReady = new Promise<string | undefined>((resolve) => {
    resolveRunId = resolve;
  });

  const publishRunId = (value?: string) => {
    const nextRunId = value?.trim() || undefined;
    if (!runId && nextRunId) {
      runId = nextRunId;
    }
    if (!runIdResolved) {
      runIdResolved = true;
      resolveRunId(runId);
    }
  };
  if (runId) publishRunId(runId);

  return {
    // `fetch(...)` below is the global fetch — the object key introduces no binding.
fetch: async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const headers = new Headers(init?.headers);
      if (runId && !headers.has(LOVABLE_AIG_RUN_ID_HEADER)) {
        headers.set(LOVABLE_AIG_RUN_ID_HEADER, runId);
      }

      try {
        const response = await fetch(input, { ...init, headers });
        publishRunId(response.headers.get(LOVABLE_AIG_RUN_ID_HEADER) ?? undefined);
        return response;
      } catch (error) {
        publishRunId(undefined);
        throw error;
      }
    },
    getRunId: () => runId,
    waitForRunId: () => (runId ? Promise.resolve(runId) : runIdReady),
  };
}

/** Chat/completions provider for non-OpenAI vendors (e.g. `google/gemini-*`). */
export function createLovableAiGatewayProvider(
  lovableApiKey: string,
  initialRunId?: string,
  options?: { structuredOutputs?: boolean },
) {
  const runIdFetch = createLovableAiGatewayRunIdFetch(initialRunId);

  const provider = createOpenAICompatible({
    name: "lovable",
    baseURL: GATEWAY_BASE_URL,
    // OpenAI structured output needs strict json_schema; without this the SDK
    // sends json_object (schema not enforced).
    supportsStructuredOutputs: options?.structuredOutputs ?? false,
    headers: {
      "Lovable-API-Key": lovableApiKey,
      "X-Lovable-AIG-SDK": "vercel-ai-sdk",
    },
    fetch: runIdFetch.fetch,
  });

  return Object.assign(provider, {
    getRunId: runIdFetch.getRunId,
    waitForRunId: runIdFetch.waitForRunId,
  });
}

/** Responses API provider for OpenAI models (e.g. the default `openai/gpt-5.6-sol`). */
export function createLovableAiGatewayResponsesProvider(
  lovableApiKey: string,
  initialRunId?: string,
) {
  const runIdFetch = createLovableAiGatewayRunIdFetch(initialRunId);

  const provider = createOpenAI({
    baseURL: GATEWAY_BASE_URL,
    apiKey: lovableApiKey, // satisfies the SDK; the gateway authenticates on the header below
    headers: {
      "Lovable-API-Key": lovableApiKey,
      "X-Lovable-AIG-SDK": "vercel-ai-sdk",
    },
    fetch: runIdFetch.fetch,
  });

  return Object.assign(provider, {
    getRunId: runIdFetch.getRunId,
    waitForRunId: runIdFetch.waitForRunId,
  });
}

export function getLovableAiGatewayRunId(request: Request) {
  return request.headers.get(LOVABLE_AIG_RUN_ID_HEADER)?.trim() || undefined;
}

export function getLovableAiGatewayResponseHeaders(
  providerHeaders: HeadersInit | undefined,
  init?: HeadersInit,
) {
  const headers = new Headers(init);
  const exposedHeaders = new Set(
    (headers.get("Access-Control-Expose-Headers") ?? "")
      .split(",")
      .map((header) => header.trim())
      .filter(Boolean),
  );

  new Headers(providerHeaders).forEach((value, name) => {
    if (name.toLowerCase().startsWith("x-lovable-aig-")) {
      headers.set(name, value);
      exposedHeaders.add(name);
    }
  });

  headers.forEach((_, name) => {
    if (name.toLowerCase().startsWith("x-lovable-aig-")) {
      exposedHeaders.add(name);
    }
  });

  if (exposedHeaders.size > 0) {
    headers.set("Access-Control-Expose-Headers", Array.from(exposedHeaders).join(", "));
  }

  return headers;
}

export async function withLovableAiGatewayRunIdHeader(
  response: Response,
  gateway: {
    getRunId: () => string | undefined;
    waitForRunId: () => Promise<string | undefined>;
  },
  init?: HeadersInit,
) {
  if (!response.body) {
    const runId = gateway.getRunId();
    const headers = getLovableAiGatewayResponseHeaders(undefined, response.headers);
    new Headers(init).forEach((value, name) => headers.set(name, value));
    if (runId) headers.set(LOVABLE_AIG_RUN_ID_HEADER, runId);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: getLovableAiGatewayResponseHeaders(undefined, headers),
    });
  }

  const reader = response.body.getReader();
  const firstChunk = reader.read();
  const runId = await gateway.waitForRunId();
  const headers = getLovableAiGatewayResponseHeaders(undefined, response.headers);
  new Headers(init).forEach((value, name) => headers.set(name, value));
  if (runId) headers.set(LOVABLE_AIG_RUN_ID_HEADER, runId);

  const body = new ReadableStream({
    async start(controller) {
      try {
        const first = await firstChunk;
        if (first.done) {
          controller.close();
          return;
        }
        controller.enqueue(first.value);
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          controller.enqueue(chunk.value);
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason?: unknown) {
      return reader.cancel(reason);
    },
  });

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: getLovableAiGatewayResponseHeaders(undefined, headers),
  });
}