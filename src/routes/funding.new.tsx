import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";
import { AlertCircle, ArrowLeft, Check, CheckCircle2, Loader2 } from "lucide-react";
import { MarketingLayout } from "@/components/layout/MarketingLayout";
import { FeatureStatus } from "@/components/brand/FeatureStatus";
import { submitFundingRequest } from "@/lib/funding-requests.functions";
import { MAX_FEE_BPS, formatFeeBps, projectApyMatrix } from "@/lib/vault-fees";
import { FUNDING_TERMS_SECTIONS, FUNDING_TERMS_VERSION } from "@/lib/onboarding-terms";

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

const STEPS = [
  "Project overview",
  "Legal structure",
  "Funding requirements",
  "Asset evidence",
  "Financial model",
  "Investor rights",
  "Risk information",
  "Review and submit",
] as const;
const CATEGORIES = ["Renewables", "Real estate", "Private credit", "Infrastructure", "Other"];
/** Illustrative gross-yield scenarios for the onboarding APY preview: 3/5/8/12%. */
const APY_SCENARIOS_BPS = [300, 500, 800, 1200];

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
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [doneSlug, setDoneSlug] = useState<string | null>(null);

  const apyMatrix = useMemo(() => projectApyMatrix(feeBps, APY_SCENARIOS_BPS), [feeBps]);

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
          termsAccepted,
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
      <MarketingLayout>
        <div className="home-container py-10 md:py-14">
          <div className="card-institutional mx-auto mt-10 max-w-2xl p-8 text-center">
            <CheckCircle2 className="mx-auto h-8 w-8 text-success" aria-hidden="true" />
            <h1 className="mt-4 font-display text-2xl font-semibold text-foreground">
              Request submitted
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              <span className="font-mono">{doneSlug}</span> is now in the public pipeline. Nothing
              has been created on chain: a governance proposal must pass before operators bootstrap
              a vault and the fee terms are written into its datum.
            </p>
            <div className="mt-6 flex flex-wrap justify-center gap-3">
              <button
                type="button"
                onClick={() => navigate({ to: "/issuer" })}
                className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
              >
                Open issuer workspace
              </button>
              <button
                type="button"
                onClick={() => navigate({ to: "/funding" })}
                className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground"
              >
                View all requests
              </button>
            </div>
          </div>
        </div>
      </MarketingLayout>
    );
  }

  const last = STEPS.length - 1;

  return (
    <MarketingLayout>
      <div className="home-container py-10 md:py-14">
        <Link
          to="/funding"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Funding requests
        </Link>
        <p className="home-eyebrow mt-4">Issuer application</p>
        <h1 className="mt-2 font-display text-3xl font-semibold text-foreground md:text-4xl">
          Submit a funding request
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          You must be signed in. Everything you enter here is public. Your answers are kept in this
          browser tab only until you submit — there is no auto-save.
        </p>

        <div className="mt-8 grid gap-8 lg:grid-cols-[240px_1fr]">
          <ol
            className="flex gap-2 overflow-x-auto pb-2 lg:flex-col lg:gap-1 lg:overflow-visible"
            aria-label="Application sections"
          >
            {STEPS.map((s, i) => (
              <li key={s} className="shrink-0">
                <button
                  type="button"
                  onClick={() => setStep(i)}
                  aria-current={i === step ? "step" : undefined}
                  className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                    i === step
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                  }`}
                >
                  <span
                    className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-semibold ${
                      i === step
                        ? "bg-primary-foreground text-primary"
                        : i < step
                          ? "bg-success text-success-foreground"
                          : "bg-secondary text-muted-foreground"
                    }`}
                  >
                    {i < step ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : i + 1}
                  </span>
                  <span className="whitespace-nowrap">{s}</span>
                </button>
              </li>
            ))}
          </ol>

          <div className="card-institutional max-w-3xl p-6 md:p-8">
            <h2 className="font-display text-xl font-semibold text-foreground">{STEPS[step]}</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Section {step + 1} of {STEPS.length}
            </p>
            <div className="mt-6">
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
                    <Hint>
                      Lowercase letters, numbers and hyphens. This becomes the vault&apos;s on-chain
                      parameter if the request is approved, so it can never change afterwards.
                    </Hint>
                  </Field>
                  <fieldset>
                    <legend className="text-sm text-muted-foreground">Category</legend>
                    <div className="mt-1 flex flex-wrap gap-2">
                      {CATEGORIES.map((c) => (
                        <button
                          key={c}
                          type="button"
                          aria-pressed={category === c}
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
                  </fieldset>
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
                      placeholder="What the asset is, who operates it, and exactly where the income comes from."
                      className="input min-h-[140px] resize-y"
                    />
                    <Hint>{description.trim().length}/80 characters minimum.</Hint>
                  </Field>
                </div>
              )}

              {step === 1 && (
                <div className="space-y-4">
                  <Field label="Legal issuer">
                    <input
                      value={issuer}
                      onChange={(e) => setIssuer(e.target.value)}
                      placeholder="Entity legally responsible for the asset"
                      className="input"
                    />
                    <Hint>
                      The registered name of the company, trust or SPV that holds the asset.
                    </Hint>
                  </Field>
                  <NotCollected
                    title="Collected on your issuer profile after you submit"
                    items={[
                      "Jurisdiction of registration",
                      "Registration number",
                      "Legal wrapper type (SPV, trust, company, co-operative, foundation)",
                      "Website",
                    ]}
                    note="Add these on the request page once it is created. An administrator reviews the profile before Gate A."
                  />
                </div>
              )}

              {step === 2 && (
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
                    <Hint>
                      The contract enforces a 10 ADA floor on the first deposit into a vault.
                    </Hint>
                  </Field>
                  <Field label="Maturity (months, optional)">
                    <input
                      value={maturityMonths}
                      onChange={(e) => setMaturityMonths(e.target.value)}
                      inputMode="numeric"
                      className="input tabular-nums"
                    />
                  </Field>
                  <div className="sm:col-span-2">
                    <NotCollected
                      title="Not collected yet"
                      items={[
                        "Soft cap",
                        "Hard cap",
                        "Funding deadline",
                        "Use of proceeds and milestones",
                      ]}
                      note="These need the escrow and milestone services, which are still being built."
                    />
                  </div>
                </div>
              )}

              {step === 3 && (
                <div className="space-y-4">
                  <Field label="Evidence links (one https URL per line)">
                    <textarea
                      value={evidence}
                      onChange={(e) => setEvidence(e.target.value)}
                      rows={5}
                      placeholder={
                        "https://registry.example/title-deed\nhttps://auditor.example/report.pdf"
                      }
                      className="input min-h-[120px] resize-y font-mono text-xs"
                    />
                    <Hint>
                      Ownership, licences, offtake agreements, independent audits. Reviewers will
                      read these; unverifiable claims get rejected. Links are public — do not share
                      confidential files.
                    </Hint>
                  </Field>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <FeatureStatus stage="awaiting_backend" /> Private uploads open with the secure
                    data room.
                  </div>
                </div>
              )}

              {step === 4 && (
                <div className="space-y-4">
                  <Field label="Reporting cadence">
                    <input
                      value={reportingCadence}
                      onChange={(e) => setReportingCadence(e.target.value)}
                      placeholder="Quarterly"
                      className="input"
                    />
                  </Field>
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
                      Charged annually on accounted vault assets, prorated by time and settled at
                      each accrual by minting shares to the treasury — no lovelace leaves the vault,
                      holders are diluted by exactly the fee owed. The validator caps the rate at{" "}
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
                  <div className="rounded-md border border-border bg-secondary/20 p-4">
                    <span className="text-sm text-muted-foreground">
                      Projected net APY at this fee rate
                    </span>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      Illustrative only, computed with the same fee formula the validator enforces
                      on chain. Not a promise of returns — actual yield depends entirely on the
                      underlying asset.
                    </p>
                    <div className="mt-3 overflow-x-auto">
                      <table className="w-full min-w-[420px] text-xs tabular-nums">
                        <thead>
                          <tr className="text-left text-muted-foreground">
                            <th className="pb-2 font-normal">Assumed gross APY</th>
                            <th className="pb-2 font-normal">Management fee</th>
                            <th className="pb-2 font-normal">Net APY to depositors</th>
                          </tr>
                        </thead>
                        <tbody>
                          {apyMatrix.map((row) => (
                            <tr key={row.grossApyBps} className="border-t border-border">
                              <td className="py-1.5 text-foreground">
                                {formatFeeBps(row.grossApyBps)}
                              </td>
                              <td className="py-1.5 text-muted-foreground">
                                {formatFeeBps(feeBps)}
                              </td>
                              <td className="py-1.5 font-medium text-foreground">
                                {formatFeeBps(row.netApyBps)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                  <NotCollected
                    title="Not collected yet"
                    items={[
                      "Revenue model and offtake pricing",
                      "Operating expense budget",
                      "Debt and tax obligations",
                      "Reserve policy",
                    ]}
                    note="The Asset-to-Yield Engine will define these fields with the backend team."
                  />
                </div>
              )}

              {step === 5 && (
                <NotCollected
                  title="Investor rights are not collected by this form yet"
                  items={[
                    "What a participation unit entitles its holder to",
                    "Voting and information rights",
                    "Transfer restrictions and lock-ups",
                    "What happens on default or wind-down",
                  ]}
                  note="Rights must come from approved legal documents. Until a project has them, Stellaris shows that no rights are offered. You can continue without filling anything here."
                  stage="awaiting_legal"
                />
              )}

              {step === 6 && (
                <NotCollected
                  title="Risk information is not collected by this form yet"
                  items={[
                    "Asset-specific operating risks",
                    "Counterparty and offtaker risk",
                    "Jurisdiction and regulatory risk",
                    "Insurance coverage and gaps",
                  ]}
                  note="Every passport already lists the standard testnet, contract, issuer, legal and liquidity risks. Project-specific risk fields arrive with the backend data contract."
                />
              )}

              {step === 7 && (
                <div className="space-y-4">
                  <dl className="grid gap-3 rounded-md border border-border bg-secondary/20 p-4 text-xs sm:grid-cols-3">
                    <Summary label="Project" value={name || "—"} />
                    <Summary label="Identifier" value={assetSlug || "—"} mono />
                    <Summary label="Issuer" value={issuer || "—"} />
                    <Summary label="Target" value={targetAda ? `${targetAda} ₳` : "—"} />
                    <Summary
                      label="Min deposit"
                      value={minDepositAda ? `${minDepositAda} ₳` : "—"}
                    />
                    <Summary label="Management fee" value={formatFeeBps(feeBps)} />
                    <Summary label="Reporting" value={reportingCadence || "—"} />
                    <Summary
                      label="Evidence links"
                      value={String(evidence.split(/\r?\n/).filter((l) => l.trim()).length)}
                    />
                    <Summary label="Category" value={category} />
                  </dl>
                  <p className="text-[11px] text-muted-foreground">
                    Submitting records a public request. It does not create an asset, derive a
                    vault, or move any funds. The server checks every field again before saving.
                  </p>
                  <div className="rounded-md border border-border bg-secondary/20 p-4">
                    <span className="text-sm text-muted-foreground">
                      Platform terms — version{" "}
                      <span className="font-mono">{FUNDING_TERMS_VERSION}</span>
                    </span>
                    <div className="mt-2 max-h-40 space-y-3 overflow-y-auto rounded border border-border bg-background p-3 text-[11px] leading-relaxed text-muted-foreground">
                      {FUNDING_TERMS_SECTIONS.map((s) => (
                        <div key={s.heading}>
                          <p className="font-medium text-foreground">{s.heading}</p>
                          <p className="mt-0.5">{s.body}</p>
                        </div>
                      ))}
                    </div>
                    <label className="mt-3 flex items-start gap-2 text-sm text-foreground">
                      <input
                        type="checkbox"
                        checked={termsAccepted}
                        onChange={(e) => setTermsAccepted(e.target.checked)}
                        className="mt-0.5"
                      />
                      <span>
                        I have read and agree to the{" "}
                        <Link to="/terms" target="_blank" className="text-primary underline">
                          platform terms
                        </Link>
                        , including that everything above is public and must be accurate.
                      </span>
                    </label>
                  </div>
                </div>
              )}
            </div>

            {error && (
              <div
                role="alert"
                className="mt-4 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
              >
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <span>{error}</span>
              </div>
            )}

            <div className="mt-8 flex items-center justify-between border-t border-border pt-5">
              <button
                type="button"
                onClick={() => setStep((s) => Math.max(0, s - 1))}
                disabled={step === 0 || busy}
                className="rounded-md border border-border px-4 py-2 text-sm text-foreground disabled:opacity-40"
              >
                Back
              </button>
              {step < last ? (
                <button
                  type="button"
                  onClick={() => setStep((s) => Math.min(last, s + 1))}
                  className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
                >
                  Continue
                </button>
              ) : (
                <button
                  type="button"
                  onClick={send}
                  disabled={busy || !termsAccepted}
                  title={!termsAccepted ? "Accept the platform terms first" : undefined}
                  className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
                >
                  {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                  {busy ? "Submitting…" : "Submit request"}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </MarketingLayout>
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

function Hint({ children }: { children: React.ReactNode }) {
  return <span className="mt-1 block text-[11px] text-muted-foreground">{children}</span>;
}

function NotCollected({
  title,
  items,
  note,
  stage = "awaiting_backend",
}: {
  title: string;
  items: string[];
  note: string;
  stage?: "awaiting_backend" | "awaiting_legal";
}) {
  return (
    <div className="rounded-xl border border-dashed border-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium text-foreground">{title}</p>
        <FeatureStatus stage={stage} />
      </div>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
        {items.map((i) => (
          <li key={i}>{i}</li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-muted-foreground">{note}</p>
    </div>
  );
}

function Summary({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={`mt-0.5 break-words text-foreground ${mono ? "font-mono" : ""}`}>{value}</dd>
    </div>
  );
}
