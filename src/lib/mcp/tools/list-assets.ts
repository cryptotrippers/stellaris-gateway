import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { ASSETS, type AssetCategory, type RiskProfile } from "@/lib/mock-data";

const CATEGORIES: AssetCategory[] = [
  "Sustainable Farming",
  "Clean Energy",
  "Real Estate",
  "Carbon Credits",
  "Infrastructure",
];
const RISKS: RiskProfile[] = ["Conservative", "Moderate", "Aggressive"];

export default defineTool({
  name: "list_assets",
  title: "List marketplace assets",
  description:
    "List tokenized real-world assets available in the Stellaris marketplace. Optionally filter by category or risk profile.",
  inputSchema: {
    category: z.enum(CATEGORIES as [AssetCategory, ...AssetCategory[]]).optional()
      .describe("Filter by asset category."),
    risk: z.enum(RISKS as [RiskProfile, ...RiskProfile[]]).optional()
      .describe("Filter by risk profile."),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: ({ category, risk }) => {
    const filtered = ASSETS.filter(
      (a) => (!category || a.category === category) && (!risk || a.risk === risk),
    );
    return {
      content: [{ type: "text", text: JSON.stringify(filtered, null, 2) }],
      structuredContent: { assets: filtered, count: filtered.length },
    };
  },
});
