import { useAccountSession } from "@/components/auth/AccountSession";

/** The signed-in user, or null. Kept client-side; the server re-verifies. */
export function useSupabaseUser() {
  return useAccountSession();
}
