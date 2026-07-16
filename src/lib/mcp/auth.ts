import { timingSafeEqual } from "node:crypto";

/**
 * Verify an MCP tool caller against the server-only MCP_API_KEY.
 *
 * Sensitive tools accept an `apiKey` input and compare it here in constant
 * time. When MCP_API_KEY is unset, the tool is unavailable (fail-closed)
 * rather than silently public.
 */
export function verifyMcpApiKey(provided: string | undefined): {
  ok: boolean;
  reason?: string;
} {
  const expected = process.env.MCP_API_KEY;
  if (!expected) {
    return { ok: false, reason: "MCP_API_KEY is not configured on the server." };
  }
  if (!provided) {
    return { ok: false, reason: "Missing apiKey. This tool requires an API key." };
  }
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return { ok: false, reason: "Invalid apiKey." };
  return timingSafeEqual(a, b)
    ? { ok: true }
    : { ok: false, reason: "Invalid apiKey." };
}
