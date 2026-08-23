import { useMemo, useState } from "react";
import { Calculator } from "lucide-react";
import { formatFeeBps, projectApyMatrix } from "@/lib/vault-fees";

const SCENARIOS: { key: string; label: string; grossApyBps: number }[] = [
  { key: "conservative", label: "Conservative", grossApyBps: 300 },
  { key: "base", label: "Base", grossApyBps: 600 },
  { key: "optimistic", label: "Optimistic", grossApyBps: 1000 },
];

/**
 * Illustrative allocation simulator. It uses the same fee arithmetic the
 * validator enforces on chain (`vault-fees`), applied to gross-yield
 * assumptions the user chooses. It is not a forecast and reads no live data.
 */
export function AllocationSimulator({
  feeBps,
  minDepositLovelace,
  years = 1,
}: {
  feeBps: number;
  minDepositLovelace?: number;
  years?: number;
}) {
  const minAda = Math.max(10, Math.round((minDepositLovelace ?? 10_000_000) / 1_000_000));
  const [amount, setAmount] = useState<number>(minAda);
  const [horizon, setHorizon] = useState<number>(years);

  const rows = useMemo(() => {
    const matrix = projectApyMatrix(
      feeBps,
      SCENARIOS.map((s) => s.grossApyBps),
    );
    return SCENARIOS.map((s, i) => {
      const netApy = (matrix[i]?.netApyBps ?? 0) / 10_000;
      const grossApy = s.grossApyBps / 10_000;
      const endValue = amount * Math.pow(1 + netApy, horizon);
      const grossValue = amount * Math.pow(1 + grossApy, horizon);
      return {
        ...s,
        netApyBps: matrix[i]?.netApyBps ?? 0,
        endValue,
        feeDrag: grossValue - endValue,
      };
    });
  }, [amount, horizon, feeBps]);

  const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 });

  return (
    <section className="card-institutional p-5">
      <h2 className="flex items-center gap-1.5 text-sm font-medium text-foreground">
        <Calculator className="h-3.5 w-3.5" /> Allocation simulator
      </h2>
      <p className="mt-1 text-[11px] text-muted-foreground">
        Illustrative only. Net returns use the exact management-fee formula enforced on chain at{" "}
        {formatFeeBps(feeBps)}; the gross yield below is an assumption you choose, not a promise or
        a measurement.
      </p>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="text-[11px] uppercase tracking-widest text-muted-foreground">
            Amount (tADA)
          </span>
          <input
            type="number"
            min={minAda}
            step={10}
            value={amount}
            onChange={(e) => setAmount(Math.max(0, Number(e.target.value)))}
            className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm tabular-nums text-foreground"
          />
          <span className="mt-1 block text-[11px] text-muted-foreground">
            Minimum deposit {minAda} tADA
          </span>
        </label>
        <label className="block">
          <span className="text-[11px] uppercase tracking-widest text-muted-foreground">
            Horizon (years)
          </span>
          <input
            type="number"
            min={1}
            max={30}
            value={horizon}
            onChange={(e) => setHorizon(Math.min(30, Math.max(1, Number(e.target.value))))}
            className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm tabular-nums text-foreground"
          />
        </label>
      </div>

      <div className="mt-4 overflow-x-auto rounded-md border border-border">
        <table className="w-full min-w-[520px] text-xs tabular-nums">
          <thead>
            <tr className="bg-secondary/20 text-left text-muted-foreground">
              <th className="px-3 py-2 font-normal">Scenario</th>
              <th className="px-3 py-2 font-normal">Assumed gross APY</th>
              <th className="px-3 py-2 font-normal">Net APY after fee</th>
              <th className="px-3 py-2 font-normal">Value after {horizon}y</th>
              <th className="px-3 py-2 font-normal">Fee drag</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="border-t border-border">
                <td className="px-3 py-1.5 text-foreground">{r.label}</td>
                <td className="px-3 py-1.5 text-muted-foreground">
                  {(r.grossApyBps / 100).toFixed(2)}%
                </td>
                <td className="px-3 py-1.5 text-foreground">{(r.netApyBps / 100).toFixed(2)}%</td>
                <td className="px-3 py-1.5 font-medium text-foreground">{fmt(r.endValue)} ₳</td>
                <td className="px-3 py-1.5 text-muted-foreground">{fmt(r.feeDrag)} ₳</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
