import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getIssuerPrivate } from "@/lib/accelerator.functions";
import { useSupabaseUser } from "@/hooks/useSupabaseUser";

/**
 * Registration number and contact email, shown only to the issuer's owner or
 * an admin. The server decides; everyone else gets nothing back.
 */
export function useIssuerPrivate(issuerId: string | null | undefined) {
  const { user } = useSupabaseUser();
  const fetchPrivate = useServerFn(getIssuerPrivate);
  return useQuery({
    queryKey: ["issuer-private", issuerId, user?.id ?? null],
    queryFn: () => fetchPrivate({ data: { issuerId: issuerId as string } }),
    enabled: Boolean(user && issuerId),
    staleTime: 60_000,
    retry: 0,
  });
}
