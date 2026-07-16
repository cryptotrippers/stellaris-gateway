import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { ASSETS } from "@/lib/mock-data";

export default defineTool({
  name: "search_assets",
  title: "Search marketplace assets",
  description:
    "Full-text search Stellaris marketplace assets by name, description, issuer, or location.",
  inputSchema: {
    query: z.string().min(1).describe("Search query."),
    limit: z.number().int().min(1).max(50).optional().describe("Max results (default 10)."),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: ({ query, limit }) => {
    const q = query.toLowerCase();
    const results = ASSETS.filter((a) =>
      [a.name, a.description, a.issuer, a.location, a.category]
        .join(" ")
        .toLowerCase()
        .includes(q),
    ).slice(0, limit ?? 10);
    return {
      content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
      structuredContent: { results, count: results.length },
    };
  },
});
