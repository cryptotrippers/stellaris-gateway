import { Link } from "@tanstack/react-router";
import { Bell, Shield } from "lucide-react";
import { StellarisWordmark } from "@/components/brand/Logo";
import { WalletButton } from "@/components/wallet/WalletButton";

export function TopAppBar() {
  return (
    <header className="sticky top-0 z-30 border-b border-border/70 bg-surface/85 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-[1400px] items-center gap-4 px-4 md:px-6">
        <Link to="/" className="shrink-0">
          <StellarisWordmark />
        </Link>

        <nav className="hidden md:flex items-center gap-1 ml-6">
          <NavItem to="/">Portfolio</NavItem>
          <NavItem to="/marketplace">Marketplace</NavItem>
          <NavItem to="/governance">Governance</NavItem>
          <NavItem to="/stewardship">Stewardship</NavItem>
          <NavItem to="/security">Security</NavItem>
          <NavItem to="/developers">Developers</NavItem>
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <Link
            to="/security"
            className="hidden sm:inline-flex items-center gap-1.5 rounded-full border border-accent/40 bg-accent/10 px-2.5 py-1 text-[11px] font-medium text-accent-foreground"
          >
            <Shield className="h-3.5 w-3.5 text-accent" />
            <span className="text-foreground/80">Institutional Grade</span>
          </Link>
          <button
            aria-label="Notifications"
            className="relative grid h-9 w-9 place-items-center rounded-full border border-border bg-surface hover:bg-secondary transition-colors"
          >
            <Bell className="h-4 w-4 text-muted-foreground" />
            <span className="absolute right-2 top-2 h-1.5 w-1.5 rounded-full bg-accent" />
          </button>
          <WalletButton />
        </div>
      </div>
    </header>
  );
}

function NavItem({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <Link
      to={to}
      activeOptions={{ exact: to === "/" }}
      activeProps={{ className: "bg-secondary text-foreground" }}
      inactiveProps={{ className: "text-muted-foreground hover:text-foreground hover:bg-secondary/60" }}
      className="rounded-lg px-3 py-1.5 text-sm font-medium transition-colors"
    >
      {children}
    </Link>
  );
}
