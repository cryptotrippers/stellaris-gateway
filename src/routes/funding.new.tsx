import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { AlertCircle, ArrowLeft, CheckCircle2, Loader2 } from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import { submitFundingRequest } from "@/lib/funding-requests.functions";
import { MAX_FEE_BPS, formatFeeBps } from "@/lib/vault-fees";

export const Route = createFileRoute("/funding/new")({
  head: () => ({
    meta: [
      { title: "Submit a Funding Request · Stellaris" },
      {
        name: "description",
        content:
          "Propose a real-world asset for on-chain funding: issuer, target raise, evidence, reporting cadence and management fee. Governance votes before any vault is created.",
      },
      { property: "og:title", content: "Submit a Funding Request · Stellaris" },
      {
        property: "og:description",
        content:
          "Propose a real-world asset for on-chain funding. Governance votes before any vault is created.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: NewFundingRequest,
});

const STEPS = ["Project", "Terms & fee", "Evidence & review"] as const;
const CATEGORIES = ["Renewables", "Real estate", "Private credit", "Infrastructure", "Other"];

function NewFundingRequest() {
  const [step, setStep] = useState(0);
  const [assetSlug, setAssetSlug] = useState("");
  const [name, setName] = useState("");
  const [category, setCategory] = useState(CATEGORIES[0]!);
  const [issuer, setIssuer] = useState("");
  const [location, setLocation] = useState("");
  const [description, setDescription] = useState("");
  const [targetAda, setTargetAda] = useState("");
  const [minDepositAda, setMinDepositAda] = useState("10");
  const [maturityMonths, setMaturityMonths] = useState("");
  const [reportingCadence, setReportingCadence] = useState("Quarterly");
  const [feeBps, setFeeBps] = useState(0);
  const [treasuryAddress, setTreasuryAddress] = useState("");
  const [evidence, setEvidence] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [doneSlug, setDoneSlug] = useState<string | null>(null);

  const submit = useServerFn(submitFundingRequest);
  const navigate = useNavigate();

  const send = async () => {
    setError(null);
    setBusy(true);
    try {
      const row = await submit({
        data: {
          assetSlug,
          name,
          category,
          issuer,
          location,
          description,
          targetAda: Number(targetAda),
          minDepositAda: Number(minDepositAda),
          maturityMonths: maturityMonths ? Number(maturityMonths) : undefined,
          reportingCadence,
          evidenceUrls: evidence
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter(Boolean),
          proposedFeeBps: feeBps,
          treasuryAddress,
        },
      });
      setDoneSlug(row.asset_slug);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (doneSlug) {
    return (
      <AppShell>
        <div className="card-institutional mx-auto mt-10 max-w-2xl p-8 text-center">
          <CheckCircle2 className="mx-auto h-8 w-8 text-success" />
          <h1 className="mt-4 text-2xl font-semibold text-foreground">Request submitted</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            <span className="font-mono">{doneSlug}</span> is now in the public pipeline. Nothing has
            been created on chain: a governance proposal must pass before operators bootstrap a vault
            and the fee terms are written into its datum.
          </p>
          <button
            type="button"
            onClick={() => navigate({ to: "/funding" })}
            className="mt-6 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
          >
            View the pipeline
          </button>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <Link
        to="/funding"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> Funding requests
      </Link>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight text-foreground">
        Submit a funding request
      </h1>
      <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
        You must be signed in. Everything you enter here is public.
      </p>

      <ol className="mt-6 flex flex-wrap items-center gap-2">
        {STEPS.map((s, i) => (
          <li key={s} className="flex items-center gap-2">
            <div
              className={`grid h-7 w-7 place-items-center rounded-full text-xs font-semibold ${
                i < step
                  ? "bg-success text-success-foreground"
                  : i === step
                    ? "bg-primary text-primary-foreground"
                    : "bg-secondary text-muted-foreground"
              }`}
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

      <div className="card-institutional mt-6 max-w-3xl p-6">
        {step === 0 && (
          <div className="space-y-4">
            <Field label="Project name">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Nordic Wind III"
                className="input"
              />
            </Field>
            <Field label="Asset identifier">
              <input
                value={assetSlug}
                onChange={(e) => setAssetSlug(e.target.value)}
                placeholder="nordic-wind-03"
                className="input font-mono"
              />
              <span className="mt-1 block text-[11px] text-muted-foreground">
                Lowercase letters, numbers and hyphens. This becomes the vault&apos;s on-chain
                parameter if the request is approved, so it can never change afterwards.
              </span>
            </Field>
            <Field label="Category">
              <div className="flex flex-wrap gap-2">
                {CATEGORIES.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setCategory(c)}
                    className={`rounded-full border px-3 py-1.5 text-sm ${
                      category === c
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border bg-surface text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {c}
                  </button>
                ))}
              </div>
            </Field>
            <Field label="Legal issuer">
              <input
                value={issuer}
                onChange={(e) => setIssuer(e.target.value)}
                placeholder="Entity legally responsible for the asset"
                className="input"
              />
            </Field>
            <Field label="Location (optional)">
              <input
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                placeholder="e.g. Jutland, Denmark"
                className="input"
              />
            </Field>
            <Field label="Description">
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={6}
                placeholder="What the asset is, who operates it, and exactly where the yield comes from."
                className="input min-h-[140px] resize-y"
              />
              <span className="mt-1 block text-[11px] text-muted-foreground">
                {description.trim().length}/80 characters minimum.
              </span>
            </Field>
          </div>
        )}

        {step === 1 && (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Target raise (ADA)">
                <input
                  value={targetAda}
                  onChange={(e) => setTargetAda(e.target.value)}
                  inputMode="decimal"
                  className="input tabular-nums"
                />
              </Field>
              <Field label="Minimum deposit (ADA)">
                <input
                  value={minDepositAda}
                  onChange={(e) => setMinDepositAda(e.target.value)}
                  inputMode="decimal"
                  className="input tabular-nums"
                />
                <span className="mt-1 block text-[11px] text-muted-foreground">
                  The contract enforces a 10 ADA floor on the first deposit into a vault.
                </span>
              </Field>
              <Field label="Maturity (months, optional)">
                <input
                  value={maturityMonths}
                  onChange={(e) => setMaturityMonths(e.target.value)}
                  inputMode="numeric"
                  className="input tabular-nums"
                />
              </Field>
              <Field label="Reporting cadence">
                <input
                  value={reportingCadence}
                  onChange={(e) => setReportingCadence(e.target.value)}
                  placeholder="Quarterly"
                  className="input"
                />
              </Field>
            </div>

            <div className="rounded-md border border-border bg-secondary/20 p-4">
              <Field label={`Management fee — ${formatFeeBps(feeBps)}`}>
                <input
                  type="range"
                  min={0}
                  max={MAX_FEE_BPS}
                  step={5}
                  value={feeBps}
                  onChange={(e) => setFeeBps(Number(e.target.value))}
                  className="w-full"
                />
              </Field>
              <p className="mt-2 text-[11px] text-muted-foreground">
                Charged annually on accounted vault assets, prorated by time and settled at each
                accrual by minting shares to the treasury — no lovelace leaves the vault, holders are
                diluted by exactly the fee owed. The validator caps the rate at{" "}
                {formatFeeBps(MAX_FEE_BPS)} and rejects retroactive changes.
              </p>
              <div className="mt-4">
                <Field label="Treasury address or key hash (optional at this stage)">
                  <input
                    value={treasuryAddress}
                    onChange={(e) => setTreasuryAddress(e.target.value)}
                    placeholder="Where fee shares are claimed to"
                    className="input font-mono text-xs"
                  />
                </Field>
              </div>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-4">
            <Field label="Evidence links (one https URL per line)">
              <textarea
                value={evidence}
                onChange={(e) => setEvidence(e.target.value)}
                rows={5}
                placeholder={"https://registry.example/title-deed\nhttps://auditor.example/report.pdf"}
                className="input min-h-[120px] resize-y font-mono text-xs"
              />
              <span className="mt-1 block text-[11px] text-muted-foreground">
                Ownership, licences, offtake agreements, independent audits. Reviewers will read
                these; unverifiable claims get rejected.
              </span>
            </Field>

            <dl className="grid gap-3 rounded-md border border-border bg-secondary/20 p-4 text-xs sm:grid-cols-3">
              <Summary label="Identifier" value={assetSlug || "—"} mono />
              <Summary label="Issuer" value={issuer || "—"} />
              <Summary label="Target" value={targetAda ? `${targetAda} ₳` : "—"} />
              <Summary label="Min deposit" value={minDepositAda ? `${minDepositAda} ₳` : "—"} />
              <Summary label="Management fee" value={formatFeeBps(feeBps)} />
              <Summary label="Reporting" value={reportingCadence || "—"} />
            </dl>

            <p className="text-[11px] text-muted-foreground">
              Submitting records a public request. It does not create an asset, derive a vault, or
              move any funds.
            </p>
          </div>
        )}

        {error && (
          <div className="mt-4 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="mt-6 flex items-center justify-between">
          <button
            type="button"
            onClick={() => setStep((s) => Math.max(0, s - 1))}
            disabled={step === 0 || busy}
            className="rounded-md border border-border px-4 py-2 text-sm text-foreground disabled:opacity-40"
          >
            Back
          </button>
          {step < STEPS.length - 1 ? (
            <button
              type="button"
              onClick={() => setStep((s) => s + 1)}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
            >
              Continue
            </button>
          ) : (
            <button
              type="button"
              onClick={send}
              disabled={busy}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {busy ? "Submitting…" : "Submit request"}
            </button>
          )}
        </div>
      </div>
    </AppShell>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="text-muted-foreground">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}

function Summary({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={`mt-0.5 text-foreground ${mono ? "font-mono" : ""}`}>{value}</dd>
    </div>
  );
}
