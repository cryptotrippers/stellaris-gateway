import { defineMcp } from "@lovable.dev/mcp-js";
import listAssetsTool from "./tools/list-assets";
import getAssetTool from "./tools/get-asset";
import searchAssetsTool from "./tools/search-assets";
import estimateYieldTool from "./tools/estimate-yield";

export default defineMcp({
  name: "stellaris-gateway-mcp",
  title: "Stellaris Gateway MCP",
  version: "0.1.0",
  instructions:
    "Read-only tools for the Stellaris Gateway app. Use `list_assets` to browse tokenized real-world assets in the marketplace, `search_assets` to search by keyword, `get_asset` for full details on one asset, and `estimate_yield` to project returns for a hypothetical investment.",
  tools: [listAssetsTool, getAssetTool, searchAssetsTool, estimateYieldTool],
});
