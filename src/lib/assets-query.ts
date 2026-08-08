import { queryOptions } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export type AssetRow = {
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
  created_at: string;
};

const COLUMNS =
  "id,name,category,issuer,location,description,target_lovelace,raised_lovelace,min_deposit_lovelace,maturity_months,funding_status,created_at";

export async function fetchAssets(): Promise<AssetRow[]> {
  const { data, error } = await supabase
    .from("assets")
    .select(COLUMNS)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as AssetRow[];
}

export const assetsQueryOptions = () =>
  queryOptions({
    queryKey: ["assets"],
    queryFn: fetchAssets,
    staleTime: 60_000,
  });

export function fundedPct(a: Pick<AssetRow, "target_lovelace" | "raised_lovelace">): number {
  const target = Number(a.target_lovelace);
  if (!(target > 0)) return 0;
  return Math.min(100, (Number(a.raised_lovelace) / target) * 100);
}
