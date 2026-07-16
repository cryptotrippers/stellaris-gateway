import { Link } from "@tanstack/react-router";
import { ArrowUpRight } from "lucide-react";

export function FundingBar({ pct }: { pct: number }) {
  return (
    <div className="mt-5">
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span>Funded</span>
        <span className="number-display text-foreground font-medium">{pct}%</span>
      </div>
      <div className="mt-1.5 h-1.5 rounded-full bg-secondary overflow-hidden">
        <div className="h-full rounded-full bg-gradient-primary" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function SectionHeader({ title, href, hrefLabel }: { title: string; href?: string; hrefLabel?: string }) {
  return (
    <div className="flex items-center justify-between">
      <h2 className="text-lg font-semibold tracking-tight text-foreground">{title}</h2>
      {href && (
        <Link to={href} className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:text-primary/80">
          {hrefLabel} <ArrowUpRight className="h-4 w-4" />
        </Link>
      )}
    </div>
  );
}
