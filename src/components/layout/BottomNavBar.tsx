import { Link } from "@tanstack/react-router";
import { LayoutDashboard, Store, Vote, ShieldCheck, Activity, type LucideIcon } from "lucide-react";

type Item = { to: string; label: string; icon: LucideIcon; exact?: boolean };
const items: Item[] = [
  { to: "/", label: "Portfolio", icon: LayoutDashboard, exact: true },
  { to: "/marketplace", label: "Market", icon: Store },
  { to: "/yield", label: "Yield", icon: Activity },
  { to: "/governance", label: "Govern", icon: Vote },
  { to: "/security", label: "Security", icon: ShieldCheck },
];

export function BottomNavBar() {
  return (
    <nav className="md:hidden fixed bottom-0 inset-x-0 z-40 border-t border-border bg-surface/95 backdrop-blur-md pb-[env(safe-area-inset-bottom)]">
      <ul className="grid grid-cols-5">
        {items.map(({ to, label, icon: Icon, exact }) => (
          <li key={to}>
            <Link
              to={to}
              activeOptions={{ exact: exact ?? false }}
              activeProps={{ className: "text-primary" }}
              inactiveProps={{ className: "text-muted-foreground" }}
              className="flex flex-col items-center justify-center gap-1 py-2.5 text-[10px] font-medium"
            >
              <Icon className="h-5 w-5" />
              {label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
