import { defineMcp } from "@lovable.dev/mcp-js";
import listAssetsTool from "./tools/list-assets";
import getAssetTool from "./tools/get-asset";
import searchAssetsTool from "./tools/search-assets";
import estimateYieldTool from "./tools/estimate-yield";
import listVaultActivityTool from "./tools/list-vault-activity";
import listStewardshipTool from "./tools/list-stewardship";

export default defineMcp({
  name: "stellaris-gateway-mcp",
  title: "Stellaris Gateway MCP",
  version: "0.2.0",
  instructions:
    "Tools for the Stellaris Gateway app. Public read-only tools browse the marketplace: `list_assets`, `search_assets`, `get_asset`, `estimate_yield`. Authenticated tools require an `apiKey` argument (the MCP_API_KEY issued by the app operator) and expose sensitive activity: `list_vault_activity` for vault flows and `list_stewardship` for governance proposals under review.",
  tools: [
    listAssetsTool,
    getAssetTool,
    searchAssetsTool,
    estimateYieldTool,
    listVaultActivityTool,
    listStewardshipTool,
  ],
});
