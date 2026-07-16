import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { PROPOSALS } from "@/lib/mock-data";
import { verifyMcpApiKey } from "../auth";

export default defineTool({
  name: "list_stewardship",
  title: "List stewardship activity (authenticated)",
  description:
    "List governance proposals under stewardship review, including voting status, quorum, and author. Requires an MCP API key.",
  inputSchema: {
    apiKey: z.string().min(1).describe("MCP API key issued by the app operator."),
    status: z.enum(["Voting", "Executed", "Defeated", "Queued"]).optional()
      .describe("Filter by proposal status."),
    category: z.enum(["Treasury", "Protocol", "Listing", "Risk"]).optional()
      .describe("Filter by proposal category."),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: ({ apiKey, status, category }) => {
    const auth = verifyMcpApiKey(apiKey);
    if (!auth.ok) {
      return { content: [{ type: "text", text: `Unauthorized: ${auth.reason}` }], isError: true };
    }
    const rows = PROPOSALS.filter(
      (p) => (!status || p.status === status) && (!category || p.category === category),
    );
    return {
      content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
      structuredContent: { proposals: rows, count: rows.length },
    };
  },
});
