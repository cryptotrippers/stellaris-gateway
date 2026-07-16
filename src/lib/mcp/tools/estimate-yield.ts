import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { ASSETS } from "@/lib/mock-data";

export default defineTool({
  name: "estimate_yield",
  title: "Estimate yield for an asset",
  description:
    "Estimate projected yield in ADA for a given Stellaris asset, investment amount, and holding period.",
  inputSchema: {
    assetId: z.string().min(1).describe("Asset ID to estimate yield for."),
    amountAda: z.number().positive().describe("Investment amount in ADA."),
    months: z.number().int().min(1).max(120).optional()
      .describe("Holding period in months (defaults to asset maturity)."),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: ({ assetId, amountAda, months }) => {
    const asset = ASSETS.find((a) => a.id === assetId);
    if (!asset) {
      return {
        content: [{ type: "text", text: `No asset found with id '${assetId}'.` }],
        isError: true,
      };
    }
    if (amountAda < asset.minInvestmentAda) {
      return {
        content: [
          {
            type: "text",
            text: `Amount ${amountAda} ADA is below the minimum investment of ${asset.minInvestmentAda} ADA for '${asset.name}'.`,
          },
        ],
        isError: true,
      };
    }
    const term = months ?? asset.maturityMonths;
    const projected = amountAda * (asset.apy / 100) * (term / 12);
    const total = amountAda + projected;
    const result = {
      asset: { id: asset.id, name: asset.name, apy: asset.apy, risk: asset.risk },
      inputAda: amountAda,
      months: term,
      projectedYieldAda: Number(projected.toFixed(2)),
      totalAtMaturityAda: Number(total.toFixed(2)),
    };
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
    };
  },
});
