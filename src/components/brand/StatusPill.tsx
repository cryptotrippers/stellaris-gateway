import { CheckCircle2, CircleDashed, FlaskConical, HelpCircle, MinusCircle } from "lucide-react";

/**
 * One status vocabulary for the whole site.
 * Clarity Standard: published / pending / not_applicable / illustrative.
 * Trust Centre:     verified / pending / demo / unknown.
 */
export type DisclosureStatus =
  | "published"
  | "verified"
  | "pending"
  | "not_applicable"
  | "illustrative"
  | "demo"
  | "unknown";

const META: Record<DisclosureStatus, { label: string; cls: string; Icon: typeof CheckCircle2 }> = {
  published: { label: "Published", cls: "border-success/30 bg-success/10 text-success", Icon: CheckCircle2 },
  verified: { label: "Verified", cls: "border-success/30 bg-success/10 text-success", Icon: CheckCircle2 },
  pending: { label: "Pending", cls: "border-gold/40 bg-gold/15 text-foreground", Icon: CircleDashed },
  not_applicable: { label: "Not applicable", cls: "border-border bg-muted text-muted-foreground", Icon: MinusCircle },
  illustrative: { label: "Illustrative", cls: "border-teal/30 bg-teal/10 text-teal", Icon: FlaskConical },
  demo: { label: "Demo", cls: "border-teal/30 bg-teal/10 text-teal", Icon: FlaskConical },
  unknown: { label: "Unknown", cls: "border-border bg-muted text-muted-foreground", Icon: HelpCircle },
};

export function StatusPill({ status, className = "", label: customLabel }: { status: DisclosureStatus; className?: string; label?: string }) {
  const { label, cls, Icon } = META[status];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${cls} ${className}`}
    >
      <Icon className="h-3 w-3" aria-hidden="true" />
      {customLabel ?? label}
    </span>
  );
}
