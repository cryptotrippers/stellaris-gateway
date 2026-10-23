import { CheckCircle2, CircleDashed, FlaskConical, Scale, ServerCog } from "lucide-react";

/** Delivery stage of a financial feature. A page must never present an unfinished feature as live. */
export type FeatureStage =
  | "verified"
  | "unverified"
  | "demo"
  | "awaiting_backend"
  | "awaiting_legal";

export const FEATURE_STAGE_META: Record<
  FeatureStage,
  { label: string; cls: string; Icon: typeof CheckCircle2 }
> = {
  verified: {
    label: "Existing and verified",
    cls: "border-success/30 bg-success/10 text-success",
    Icon: CheckCircle2,
  },
  unverified: {
    label: "Existing but unverified",
    cls: "border-gold/40 bg-gold/15 text-foreground",
    Icon: CircleDashed,
  },
  demo: {
    label: "UI demonstration only",
    cls: "border-teal/30 bg-teal/10 text-teal",
    Icon: FlaskConical,
  },
  awaiting_backend: {
    label: "Waiting for backend",
    cls: "border-border bg-muted text-muted-foreground",
    Icon: ServerCog,
  },
  awaiting_legal: {
    label: "Waiting for legal/compliance approval",
    cls: "border-border bg-muted text-muted-foreground",
    Icon: Scale,
  },
};

export function FeatureStatus({ stage, className = "" }: { stage: FeatureStage; className?: string }) {
  const { label, cls, Icon } = FEATURE_STAGE_META[stage];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${cls} ${className}`}
    >
      <Icon className="h-3 w-3" aria-hidden="true" />
      {label}
    </span>
  );
}
