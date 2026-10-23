import { useQuery } from "@tanstack/react-query";
import { getMyRoles } from "@/lib/asset-vaults.functions";
import { useSupabaseUser } from "@/hooks/useSupabaseUser";

/**
 * Roles for the signed-in user, read through the authenticated server function.
 * Only used to decide which menu links to show — every protected page and
 * server function re-checks access itself.
 */
export function useMyRoles() {
  const { user, loading } = useSupabaseUser();
  const q = useQuery({
    queryKey: ["my-roles", user?.id ?? null],
    queryFn: () => getMyRoles(),
    enabled: !!user,
    staleTime: 300_000,
    retry: 0,
  });
  const roles = q.data?.roles ?? [];
  return {
    user,
    loading: loading || (!!user && q.isLoading),
    roles,
    isAdmin: roles.includes("admin"),
  };
}
