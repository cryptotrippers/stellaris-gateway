import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Activity, CheckCircle2, AlertCircle, XCircle, HelpCircle, ArrowUpRight } from "lucide-react";
import { Badge } from "@/components/ui/StatusBadge";
import { getBlockfrostHealth, getPreprodTip, type BlockfrostHealthStatus } from "@/lib/blockfrost.functions";

const STATUS_META: Record<BlockfrostHealthStatus, { label: string; tone: "success" | "destructive" | "warning" | "muted"; Icon: typeof CheckCircle2 }> = {
  ok:            { label: "Operational",    tone: "success",     Icon: CheckCircle2 },
  missing:       { label: "Not configured", tone: "destructive", Icon: XCircle },
  wrong_network: { label: "Wrong network",  tone: "destructive", Icon: XCircle },
  invalid:       { label: "Invalid key",    tone: "destructive", Icon: XCircle },
  unreachable:   { label: "Unreachable",    tone: "warning",     Icon: AlertCircle },
};

export function ChainStatusCard() {
  const healthQ = useQuery({
    queryKey: ["preprod", "blockfrost-health"],
    queryFn: () => getBlockfrostHealth(),
    refetchInterval: 30_000,
    staleTime: 15_000,
    retry: 0,
  });
  const tipQ = useQuery({
    queryKey: ["preprod", "tip"],
    queryFn: () => getPreprodTip(),
    refetchInterval: 30_000,
    staleTime: 15_000,
    retry: 0,
    enabled: healthQ.data?.status === "ok",
  });

  const health = healthQ.data;
  const meta = health ? STATUS_META[health.status] : null;
  const Icon = meta?.Icon ?? HelpCircle;
  const detectedNetwork = health?.detectedNetwork ?? "—";

  return (
    <Link
      to="/blockfrost-health"
      className="card-institutional card-institutional-hover block p-5 group"
      aria-label="Chain status details"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold text-foreground">Chain status</h3>
        </div>
        {meta ? (
          <Badge tone={meta.tone}>
            <Icon className="h-3 w-3" /> {meta.label}
          </Badge>
        ) : (
          <Badge tone="muted">
            <HelpCircle className="h-3 w-3" /> Checking…
          </Badge>
        )}
      </div>

      <div className="mt-4 grid grid-cols-3 gap-3">
        <Stat label="Network" value={detectedNetwork} accent={health?.status === "wrong_network"} />
        <Stat label="Epoch" value={tipQ.data ? String(tipQ.data.epoch) : "—"} />
        <Stat label="Block" value={tipQ.data ? tipQ.data.block.toLocaleString() : "—"} />
      </div>

      {health && (
        <p className="mt-3 line-clamp-2 text-xs text-muted-foreground">{health.detail}</p>
      )}

      <div className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-primary">
        View diagnostics
        <ArrowUpRight className="h-3.5 w-3.5 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
      </div>
    </Link>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-widest text-muted-foreground">{label}</div>
      <div className={`number-display mt-1 text-sm font-semibold break-words ${accent ? "text-destructive" : "text-foreground"}`}>
        {value}
      </div>
    </div>
  );
}
