import { Link } from "@tanstack/react-router";
import { LayoutDashboard, Store, Vote, Home, MoreHorizontal, type LucideIcon } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MORE_LINKS } from "@/components/layout/MoreMenu";

type Item = { to: string; label: string; icon: LucideIcon; exact?: boolean };
const items: Item[] = [
  { to: "/", label: "Home", icon: Home, exact: true },
  { to: "/marketplace", label: "Invest", icon: Store },
  { to: "/app", label: "My Portfolio", icon: LayoutDashboard, exact: true },
  { to: "/governance", label: "Vote", icon: Vote },
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
        <li>
          <DropdownMenu>
            <DropdownMenuTrigger className="flex w-full flex-col items-center justify-center gap-1 py-2.5 text-[10px] font-medium text-muted-foreground">
              <MoreHorizontal className="h-5 w-5" />
              More
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" side="top" className="w-56">
              {MORE_LINKS.map(item => (
                <DropdownMenuItem key={item.to} asChild>
                  <Link to={item.to}>{item.label}</Link>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </li>
      </ul>
    </nav>
  );
}
