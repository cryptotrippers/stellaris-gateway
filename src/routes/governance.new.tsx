import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { ArrowLeft, ChevronRight, CheckCircle2, Loader2, AlertCircle } from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import { createVaultProposal } from "@/lib/governance-vault.functions";

export const Route = createFileRoute("/governance/new")({
  head: () => ({
    meta: [
      { title: "New Proposal · Stellaris Governance" },
      {
        name: "description",
        content: "Submit a community signal proposal for a Stellaris Improvement Proposal (SIP).",
      },
    ],
  }),
  component: NewProposal,
});

const STEPS = ["Basics", "Review & submit"] as const;

function NewProposal() {
  const [step, setStep] = useState(0);
  const [title, setTitle] = useState("");
  const [assetId, setAssetId] = useState("");
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sipNumber, setSipNumber] = useState<string | null>(null);
  const submitProposal = useServerFn(createVaultProposal);
  const navigate = useNavigate();

  async function handleSubmit() {
    setError(null);
    setSubmitting(true);
    try {
      const result = await submitProposal({
        data: {
          title,
          body,
          kind: "signal",
          assetId: assetId.trim() || null,
        },
      });
      setSipNumber(result.sipNumber);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to submit proposal");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AppShell>
      <Link
        to="/governance"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> Governance
      </Link>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight text-foreground">
        New Stellaris Improvement Proposal
      </h1>
      <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
        This composer creates a community <span className="font-mono">signal</span> proposal — a
        non-binding vote weighted by verified vault positions. Proposals that authorise a specific
        on-chain action (accruals, fee changes, committee changes, funding a new asset) go through
        their own flows, e.g.{" "}
        <Link to="/funding/new" className="text-primary underline">
          submitting a funding request
        </Link>
        .
      </p>

      {sipNumber ? (
        <div className="mt-6 card-institutional max-w-3xl p-6 text-center">
          <div className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-success/15 text-success">
            <CheckCircle2 className="h-8 w-8" />
          </div>
          <h3 className="mt-3 text-lg font-semibold text-foreground">Proposal submitted</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            <span className="font-mono">{sipNumber}</span> is now open for voting.
          </p>
          <div className="mt-5 flex justify-center gap-3">
            <Link
              to="/governance/$sip"
              params={{ sip: sipNumber }}
              className="rounded-xl bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground"
            >
              Open {sipNumber}
            </Link>
            <button
              onClick={() => navigate({ to: "/governance" })}
              className="rounded-xl border border-border px-5 py-2.5 text-sm font-semibold text-foreground"
            >
              Back to Governance
            </button>
          </div>
        </div>
      ) : (
        <>
          <ol className="mt-6 flex items-center gap-2">
            {STEPS.map((s, i) => (
              <li key={s} className="flex items-center gap-2">
                <div
                  className={`grid h-7 w-7 place-items-center rounded-full text-xs font-semibold ${i < step ? "bg-success text-success-foreground" : i === step ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground"}`}
                >
                  {i < step ? "✓" : i + 1}
                </div>
                <span
                  className={`text-sm ${i === step ? "font-semibold text-foreground" : "text-muted-foreground"}`}
                >
                  {s}
                </span>
                {i < STEPS.length - 1 && <div className="h-px w-8 bg-border" />}
              </li>
            ))}
          </ol>

          <div className="mt-6 card-institutional max-w-3xl p-6">
            {step === 0 && (
              <div className="space-y-4">
                <Field label="Proposal title">
                  <input
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="e.g. Prioritise a Nordic Wind III capacity report next quarter"
                    className="input"
                  />
                  <span className="mt-1 block text-[11px] text-muted-foreground">
                    6–160 characters.
                  </span>
                </Field>
                <Field label="Related asset (optional)">
                  <input
                    value={assetId}
                    onChange={(e) => setAssetId(e.target.value)}
                    placeholder="e.g. sfm-01 — leave blank for a protocol-wide signal"
                    className="input font-mono"
                  />
                </Field>
                <Field label="Rationale">
                  <textarea
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                    rows={6}
                    placeholder="What you're proposing and why. Voters see exactly this text."
                    className="input min-h-[140px] resize-y"
                  />
                  <span className="mt-1 block text-[11px] text-muted-foreground">
                    {body.trim().length}/40 characters minimum.
                  </span>
                </Field>
              </div>
            )}

            {step === 1 && (
              <div>
                <h3 className="text-sm font-semibold text-foreground">Review</h3>
                <dl className="mt-3 divide-y divide-border">
                  <ReviewRow k="Title" v={title || "—"} />
                  <ReviewRow k="Related asset" v={assetId.trim() || "None — protocol-wide"} />
                  <ReviewRow k="Rationale" v={body || "—"} />
                  <ReviewRow k="Voting window" v="7 days from submission" />
                  <ReviewRow
                    k="Voting weight"
                    v="Each voter's verified vault position, at cast time"
                  />
                </dl>
              </div>
            )}

            <div className="mt-8 space-y-3">
              {error && (
                <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
                  <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                  <span>{error}</span>
                </div>
              )}
              <div className="flex items-center justify-between">
                <button
                  onClick={() => setStep((s) => Math.max(0, s - 1))}
                  disabled={step === 0 || submitting}
                  className="text-sm text-muted-foreground hover:text-foreground disabled:opacity-40"
                >
                  Back
                </button>
                {step < STEPS.length - 1 ? (
                  <button
                    onClick={() => setStep((s) => s + 1)}
                    disabled={title.trim().length < 6 || body.trim().length < 40}
                    className="inline-flex items-center gap-1 rounded-xl bg-gradient-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground shadow-glow disabled:opacity-50"
                  >
                    Continue <ChevronRight className="h-4 w-4" />
                  </button>
                ) : (
                  <button
                    onClick={handleSubmit}
                    disabled={submitting}
                    className="inline-flex items-center gap-2 rounded-xl bg-gradient-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground shadow-glow disabled:opacity-60"
                  >
                    {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                    {submitting ? "Submitting…" : "Submit proposal"}
                  </button>
                )}
              </div>
            </div>
          </div>
        </>
      )}

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
      <span className="text-right font-medium text-foreground max-w-[60%] whitespace-pre-wrap">
        {v}
      </span>
    </div>
  );
}
