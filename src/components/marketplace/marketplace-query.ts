import { queryOptions } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

/** Public asset registry row, including the disclosure fields the passport uses. */
export type MarketAsset = {
  id: string;
  name: string;
  category: string;
  issuer: string;
  location: string | null;
  description: string | null;
  target_lovelace: number;
  raised_lovelace: number;
  min_deposit_lovelace: number;
  maturity_months: number | null;
  funding_status: string;
  audit_report_url: string | null;
  data_source: string;
  created_at: string;
  updated_at: string;
};

export const MARKET_ASSET_COLUMNS =
  "id,name,category,issuer,location,description,target_lovelace,raised_lovelace,min_deposit_lovelace,maturity_months,funding_status,audit_report_url,data_source,created_at,updated_at";

/** Read through the public client; row-level rules decide what is visible. */
export const marketAssetsQuery = () =>
  queryOptions({
    queryKey: ["market-assets"],
    queryFn: async (): Promise<MarketAsset[]> => {
      const { data, error } = await supabase
        .from("assets")
        .select(MARKET_ASSET_COLUMNS)
        .order("created_at", { ascending: false });
      if (error) throw new Error(error.message);
      return (data ?? []) as MarketAsset[];
    },
    staleTime: 60_000,
  });
