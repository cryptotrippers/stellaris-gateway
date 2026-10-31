import { Link } from "@tanstack/react-router";
import { ChevronDown, LogOut, ShieldCheck, UserRound } from "lucide-react";
import { useAccountSignOut } from "@/components/auth/useAccountSignOut";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { useMyRoles } from "@/hooks/useMyRoles";
import { accountGroups } from "./account-links";

/** Desktop account control for the public navigation. */
export function AccountMenu() {
  const { user, isAdmin, loading } = useMyRoles();
  const logout = useAccountSignOut();

  if (loading) return <span className="text-xs text-muted-foreground">Account…</span>;
  if (!user) {
    return (
      <Button asChild variant="ghost" className="hidden h-10 md:inline-flex">
        <Link to="/auth">Sign in</Link>
      </Button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" className="hidden h-10 gap-1.5 px-3 md:inline-flex" aria-label="Account menu">
          <UserRound className="h-4 w-4" aria-hidden="true" />
          <span className="hidden xl:inline">Account</span>
          <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[30rem] max-w-[calc(100vw-2rem)] p-3">
        <p className="truncate px-1 pb-2 text-xs text-muted-foreground">{user.email}</p>
        <div className={`grid gap-3 ${isAdmin ? "grid-cols-3" : "grid-cols-2"}`}>
          {accountGroups(isAdmin).map((g) => (
            <div key={g.title}>
              <DropdownMenuLabel className="px-1 text-[11px] uppercase tracking-wider text-muted-foreground">
                {g.title}
              </DropdownMenuLabel>
              {g.links.map((l) => (
                <DropdownMenuItem key={`${l.to}#${l.hash ?? ""}`} asChild>
                  <Link to={l.to} hash={l.hash} className="text-sm">
                    {l.label}
                  </Link>
                </DropdownMenuItem>
              ))}
            </div>
          ))}
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild><Link to="/account">Account & wallets</Link></DropdownMenuItem>
        {logout.error && <p role="alert" className="p-2 text-xs text-destructive">{logout.error}</p>}
        <p className="flex items-center gap-1.5 px-1 py-1 text-[11px] text-muted-foreground">
          <ShieldCheck className="h-3.5 w-3.5 text-teal" aria-hidden="true" />
          Account login is separate from wallet connection.
        </p>
        <DropdownMenuItem disabled={logout.busy} onSelect={() => void logout.signOut()} className="text-sm">
          <LogOut className="h-4 w-4" aria-hidden="true" /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Mobile account section rendered inside the collapsible menu. */
export function MobileAccountLinks({ onNavigate }: { onNavigate: () => void }) {
  const { user, isAdmin, loading } = useMyRoles();
  const logout = useAccountSignOut();
  if (loading) return <span className="text-xs text-muted-foreground">Account…</span>;
  if (!user) {
    return (
      <Button asChild variant="ghost" className="justify-start">
        <Link to="/auth" onClick={onNavigate}>
          Sign in
        </Link>
      </Button>
    );
  }
  return (
    <div className="mt-2 grid gap-3 border-t border-border pt-3">
      <Button asChild variant="ghost" className="min-h-11 justify-start"><Link to="/account" onClick={onNavigate}>Account & wallets</Link></Button>
      {logout.error && <p role="alert" className="text-xs text-destructive">{logout.error}</p>}
      {accountGroups(isAdmin).map((g) => (
        <div key={g.title}>
          <p className="px-4 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {g.title}
          </p>
          <div className="mt-1 grid grid-cols-2 gap-1">
            {g.links.map((l) => (
              <Button
                key={`${l.to}#${l.hash ?? ""}`}
                asChild
                variant="ghost"
                size="sm"
                className="justify-start"
              >
                <Link to={l.to} hash={l.hash} onClick={onNavigate}>
                  {l.label}
                </Link>
              </Button>
            ))}
          </div>
        </div>
      ))}
      <Button
        variant="ghost"
        className="justify-start"
        onClick={() => {
          void logout.signOut();
          onNavigate();
        }}
      >
        <LogOut className="h-4 w-4" aria-hidden="true" /> Sign out
      </Button>
    </div>
  );
}
