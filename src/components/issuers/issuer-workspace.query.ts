import { queryOptions } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export type WorkspaceIssuer = {
  id: string;
  legal_name: string;
  jurisdiction: string;
  registration_number: string | null;
  website: string | null;
  wrapper_type: string;
  verification_status: "unverified" | "pending" | "verified" | "rejected";
  verified_at: string | null;
  created_at: string;
};

export type WorkspaceRequest = {
  id: string;
  asset_slug: string;
  name: string;
  category: string;
  status: string;
  created_at: string;
  reporting_cadence: string | null;
  issuer_id: string | null;
  asset_id: string | null;
  proposal_id: string | null;
};

/**
 * The signed-in user's own issuer profiles and funding requests, read with
 * the browser client so row-level rules apply. Filtering by owner here is a
 * convenience, not a permission: the server decides what each user may change.
 */
export const issuerWorkspaceQuery = (userId: string) =>
  queryOptions({
    queryKey: ["issuer-workspace", userId],
    queryFn: async () => {
      const [issuers, requests] = await Promise.all([
        supabase
          .from("issuers")
          .select("id, legal_name, jurisdiction, registration_number, website, wrapper_type, verification_status, verified_at, created_at")
          .eq("owner_user_id", userId)
          .order("created_at", { ascending: false }),
        supabase
          .from("funding_requests")
          .select("id, asset_slug, name, category, status, created_at, reporting_cadence, issuer_id, asset_id, proposal_id")
          .eq("submitted_by", userId)
          .order("created_at", { ascending: false }),
      ]);
      if (issuers.error) throw new Error(issuers.error.message);
      if (requests.error) throw new Error(requests.error.message);
      return {
        issuers: (issuers.data ?? []) as WorkspaceIssuer[],
        requests: (requests.data ?? []) as WorkspaceRequest[],
      };
    },
    staleTime: 30_000,
  });
