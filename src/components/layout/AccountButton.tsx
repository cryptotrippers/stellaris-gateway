import { Link } from "@tanstack/react-router";
import { UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSupabaseUser } from "@/hooks/useSupabaseUser";

/** Mobile and app-header entry point shares the root account session. */
export function AccountButton() {
  const { user, loading } = useSupabaseUser();
  return <Button asChild variant="outline" className="min-h-11 px-3" aria-label={user ? "Your account" : "Sign in"}>
    <Link to={user ? "/account" : "/auth"}><UserRound /><span className="hidden sm:inline">{loading ? "Account" : user ? "Account" : "Sign in"}</span></Link>
  </Button>;
}
