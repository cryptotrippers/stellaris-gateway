import { Link } from "@tanstack/react-router";
import { MoreHorizontal } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** Secondary destinations, grouped so the main bar stays down to four choices. */
export const MORE_LINKS: { to: string; label: string; hint: string }[] = [
  { to: "/yield", label: "Earnings", hint: "How returns are paid out" },
  { to: "/stewardship", label: "Impact", hint: "What your money does" },
  { to: "/security", label: "Security", hint: "Account & protections" },
  { to: "/invite", label: "Invite friends", hint: "Share your link" },
  { to: "/developers", label: "Developers", hint: "API & docs" },
  { to: "/operators", label: "Operators", hint: "Admin tools" },
];

export function MoreMenu({ triggerClassName }: { triggerClassName?: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={
          triggerClassName ??
          "inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors"
        }
      >
        More
        <MoreHorizontal className="h-4 w-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60">
        {MORE_LINKS.map(item => (
          <DropdownMenuItem key={item.to} asChild>
            <Link to={item.to} className="flex flex-col items-start gap-0.5">
              <span className="text-sm font-medium text-foreground">{item.label}</span>
              <span className="text-xs text-muted-foreground">{item.hint}</span>
            </Link>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
