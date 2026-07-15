import type { ReactNode } from "react";

type Tone = "primary" | "accent" | "success" | "warning" | "destructive" | "muted";
const tones: Record<Tone, string> = {
  primary: "bg-primary/10 text-primary border-primary/20",
  accent: "bg-accent/15 text-accent-foreground border-accent/30",
  success: "bg-success/10 text-success border-success/25",
  warning: "bg-warning/15 text-warning-foreground border-warning/30",
  destructive: "bg-destructive/10 text-destructive border-destructive/25",
  muted: "bg-secondary text-muted-foreground border-border",
};

export function Badge({ tone = "muted", children, className = "" }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] font-medium uppercase tracking-wider ${tones[tone]} ${className}`}>
      {children}
    </span>
  );
}

export function RiskBadge({ risk }: { risk: "Conservative" | "Moderate" | "Aggressive" }) {
  const tone: Tone = risk === "Conservative" ? "success" : risk === "Moderate" ? "primary" : "warning";
  return <Badge tone={tone}>{risk}</Badge>;
}
