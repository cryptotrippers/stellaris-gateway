import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { VAULT_ACTIVITY } from "@/lib/mock-data";
import { verifyMcpApiKey } from "../auth";

export default defineTool({
  name: "list_vault_activity",
  title: "List vault activity (authenticated)",
  description:
    "List recent vault activity — deposits, withdrawals, yield distributions, rebalances, and timelock events. Requires an MCP API key.",
  inputSchema: {
    apiKey: z.string().min(1).describe("MCP API key issued by the app operator."),
    limit: z.number().int().min(1).max(100).optional()
      .describe("Max entries to return (default 20)."),
    kind: z.enum(["Deposit", "Withdrawal", "Yield Distribution", "Rebalance", "Timelock Set"])
      .optional().describe("Filter by activity kind."),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: ({ apiKey, limit, kind }) => {
    const auth = verifyMcpApiKey(apiKey);
    if (!auth.ok) {
      return { content: [{ type: "text", text: `Unauthorized: ${auth.reason}` }], isError: true };
    }
    const rows = VAULT_ACTIVITY.filter((e) => !kind || e.kind === kind).slice(0, limit ?? 20);
    return {
      content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
      structuredContent: { activity: rows, count: rows.length },
    };
  },
});
