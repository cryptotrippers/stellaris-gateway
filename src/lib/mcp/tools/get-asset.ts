import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { ASSETS } from "@/lib/mock-data";

export default defineTool({
  name: "get_asset",
  title: "Get asset details",
  description:
    "Fetch full details for a single Stellaris marketplace asset by its ID (e.g. 'sfm-01').",
  inputSchema: {
    id: z.string().min(1).describe("The asset ID, e.g. 'sfm-01'."),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: ({ id }) => {
    const asset = ASSETS.find((a) => a.id === id);
    if (!asset) {
      return {
        content: [{ type: "text", text: `No asset found with id '${id}'.` }],
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(asset, null, 2) }],
      structuredContent: { asset },
    };
  },
});
