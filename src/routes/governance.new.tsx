import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { ArrowLeft, ChevronRight, CheckCircle2, Loader2, AlertCircle } from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import { createProposal } from "@/lib/governance-submit.functions";

export const Route = createFileRoute("/governance/new")({
  head: () => ({
    meta: [
      { title: "New Proposal · Stellaris Governance" },
      { name: "description", content: "Draft a Stellaris Improvement Proposal (SIP). Basics, contract logic, review & sign." },
    ],
  }),
  component: NewProposal,
});

const STEPS = ["Basics", "Contract Logic", "Review & Sign"] as const;

function NewProposal() {
  const [step, setStep] = useState(0);
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("Treasury");
  const [summary, setSummary] = useState("");
  const [code, setCode] = useState(`-- Plutus V3 handler
validator stellarisTreasury {
  spend(datum, redeemer, ctx) => {
    ...
  }
}`);
  const [signed, setSigned] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sipNumber, setSipNumber] = useState<string | null>(null);
  const submitProposal = useServerFn(createProposal);
  const navigate = useNavigate();

  async function handleSubmit() {
    setError(null);
    setSubmitting(true);
    try {
      const result = await submitProposal({ data: { title, category, summary, code } });
      setSipNumber(result.sip_number);
      setSigned(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to submit proposal");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AppShell>
      <Link to="/governance" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> Governance
      </Link>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight text-foreground">New Stellaris Improvement Proposal</h1>

      <ol className="mt-6 flex items-center gap-2">
        {STEPS.map((s, i) => (
          <li key={s} className="flex items-center gap-2">
            <div className={`grid h-7 w-7 place-items-center rounded-full text-xs font-semibold ${i < step ? "bg-success text-success-foreground" : i === step ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground"}`}>
              {i < step ? "✓" : i + 1}
            </div>
            <span className={`text-sm ${i === step ? "font-semibold text-foreground" : "text-muted-foreground"}`}>{s}</span>
            {i < STEPS.length - 1 && <div className="h-px w-8 bg-border" />}
          </li>
        ))}
      </ol>

      <div className="mt-6 card-institutional p-6 max-w-3xl">
        {step === 0 && (
          <div className="space-y-4">
            <Field label="Proposal title">
              <input value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Increase Nordic Wind III allocation to 3M ADA" className="input" />
            </Field>
            <Field label="Category">
              <div className="flex flex-wrap gap-2">
                {["Treasury", "Protocol", "Listing", "Risk"].map(c => (
                  <button key={c} onClick={() => setCategory(c)} className={`rounded-full border px-3 py-1.5 text-sm ${category === c ? "border-primary bg-primary text-primary-foreground" : "border-border bg-surface text-muted-foreground hover:text-foreground"}`}>{c}</button>
                ))}
              </div>
            </Field>
            <Field label="Executive summary">
              <textarea value={summary} onChange={e => setSummary(e.target.value)} rows={5} placeholder="Motivation, expected impact, risks…" className="input min-h-[120px] resize-y" />
            </Field>
          </div>
        )}

        {step === 1 && (
          <Field label="Plutus / on-chain logic">
            <textarea value={code} onChange={e => setCode(e.target.value)} rows={14} className="input font-mono text-xs min-h-[280px]" />
            <p className="mt-2 text-[11px] text-muted-foreground">Compiled bytecode will be verified against Certik audit before executing.</p>
          </Field>
        )}

        {step === 2 && !signed && (
          <div>
            <h3 className="text-sm font-semibold text-foreground">Review</h3>
            <dl className="mt-3 divide-y divide-border">
              <ReviewRow k="Title" v={title || "—"} />
              <ReviewRow k="Category" v={category} />
              <ReviewRow k="Summary" v={summary || "—"} />
              <ReviewRow k="Contract size" v={`${code.length} chars`} />
              <ReviewRow k="Timelock" v="24 hours" />
              <ReviewRow k="Deposit" v="₳ 1,000 (refunded on quorum)" />
            </dl>
          </div>
        )}

        {step === 2 && signed && (
          <div className="text-center py-6">
            <div className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-success/15 text-success">
              <CheckCircle2 className="h-8 w-8" />
            </div>
            <h3 className="mt-3 text-lg font-semibold text-foreground">Proposal submitted</h3>
            <p className="mt-1 text-sm text-muted-foreground">{sipNumber ?? "SIP"} · Voting opens in 24h after timelock.</p>
            <button onClick={() => navigate({ to: "/governance" })} className="mt-5 rounded-xl bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground">Back to Governance</button>
          </div>
        )}

        {!signed && (
          <div className="mt-8 space-y-3">
            {error && (
              <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}
            <div className="flex items-center justify-between">
              <button onClick={() => setStep(s => Math.max(0, s - 1))} disabled={step === 0 || submitting} className="text-sm text-muted-foreground hover:text-foreground disabled:opacity-40">Back</button>
              {step < 2 ? (
                <button onClick={() => setStep(s => s + 1)} className="inline-flex items-center gap-1 rounded-xl bg-gradient-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground shadow-glow">
                  Continue <ChevronRight className="h-4 w-4" />
                </button>
              ) : (
                <button onClick={handleSubmit} disabled={submitting} className="inline-flex items-center gap-2 rounded-xl bg-gradient-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground shadow-glow disabled:opacity-60">
                  {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                  {submitting ? "Submitting…" : "Sign & submit"}
                </button>
              )}
            </div>
          </div>
        )}
      </div>


      <style>{`.input{width:100%;border:1px solid var(--color-border);background:var(--color-surface);border-radius:0.75rem;padding:0.65rem 0.85rem;font-size:0.875rem;color:var(--color-foreground);outline:none} .input:focus{border-color:var(--color-primary);box-shadow:0 0 0 3px oklch(0.55 0.19 258 / 0.2)}`}</style>
    </AppShell>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1.5 text-xs font-medium text-muted-foreground">{label}</div>
      {children}
    </label>
  );
}
function ReviewRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-start justify-between gap-4 py-3 text-sm">
      <span className="text-muted-foreground">{k}</span>
      <span className="text-right font-medium text-foreground max-w-[60%]">{v}</span>
    </div>
  );
}
