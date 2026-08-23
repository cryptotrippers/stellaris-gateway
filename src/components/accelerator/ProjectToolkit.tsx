import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  BadgeCheck,
  Building2,
  CheckCircle2,
  CircleDashed,
  Clock,
  Leaf,
  Loader2,
  ShieldAlert,
  XCircle,
} from "lucide-react";
import {
  getProjectToolkit,
  reviewChecklistItem,
  saveChecklistItem,
  saveIssuer,
  setIssuerVerification,
  saveImpactAttestation,
} from "@/lib/accelerator.functions";
import { CHECKLIST_ITEMS, type ChecklistStatus } from "@/lib/accelerator.shared";
import { ReadinessMeter } from "./ReadinessMeter";

const STATUS_ICON: Record<ChecklistStatus, React.ReactNode> = {
  missing: <CircleDashed className="h-4 w-4 text-muted-foreground" />,
  submitted: <Clock className="h-4 w-4 text-accent" />,
  verified: <CheckCircle2 className="h-4 w-4 text-primary" />,
  rejected: <XCircle className="h-4 w-4 text-destructive" />,
};

export function useProjectToolkit(slug: string) {
  return useQuery({
    queryKey: ["project-toolkit", slug],
    queryFn: () => getProjectToolkit({ data: { slug } }),
  });
}

/**
 * Issuer profile, verification checklist and impact attestations for one
 * funding request. Read-only for the public; editable by the submitter, with
 * verify/reject reserved for admins (enforced in the database).
 */
export function ProjectToolkit({
  slug,
  fundingRequestId,
  canEdit,
  isAdmin,
}: {
  slug: string;
  fundingRequestId: string;
  canEdit: boolean;
  isAdmin: boolean;
}) {
  const qc = useQueryClient();
  const q = useProjectToolkit(slug);
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["project-toolkit", slug] });
    void qc.invalidateQueries({ queryKey: ["pipeline"] });
  };

  const saveItem = useServerFn(saveChecklistItem);
  const review = useServerFn(reviewChecklistItem);
  const verifyIssuer = useServerFn(setIssuerVerification);

  const itemMut = useMutation({
    mutationFn: (v: { itemKey: string; evidenceUrl: string }) =>
      saveItem({ data: { fundingRequestId, itemKey: v.itemKey, evidenceUrl: v.evidenceUrl } }),
    onSuccess: invalidate,
  });
  const reviewMut = useMutation({
    mutationFn: (v: { itemKey: string; status: "verified" | "rejected" | "submitted" }) =>
      review({ data: { fundingRequestId, itemKey: v.itemKey, status: v.status } }),
    onSuccess: invalidate,
  });
  const issuerVerifyMut = useMutation({
    mutationFn: (v: { issuerId: string; status: "pending" | "verified" | "rejected" }) =>
      verifyIssuer({ data: v }),
    onSuccess: invalidate,
  });

  const data = q.data;
  const byKey = new Map((data?.checklist ?? []).map((c) => [c.item_key, c]));
  const err =
    (itemMut.error as Error | null)?.message ??
    (reviewMut.error as Error | null)?.message ??
    (issuerVerifyMut.error as Error | null)?.message ??
    null;

  return (
    <div className="mt-6 space-y-6">
      {/* ---------------- Issuer ---------------- */}
      <section className="card-institutional p-5">
        <h2 className="flex items-center gap-1.5 text-sm font-medium text-foreground">
          <Building2 className="h-3.5 w-3.5" /> Issuer
        </h2>
        {q.isLoading ? (
          <p className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> Loading…
          </p>
        ) : data?.issuer ? (
          <div className="mt-3">
            <div className="flex flex-wrap items-center gap-2">
              <Link
                to="/issuers/$id"
                params={{ id: data.issuer.id }}
                className="text-sm font-medium text-foreground hover:text-primary"
              >
                {data.issuer.legal_name}
              </Link>
              <VerificationBadge status={data.issuer.verification_status} />
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {data.issuer.jurisdiction} · {data.issuer.wrapper_type}
              {data.issuer.registration_number ? ` · reg ${data.issuer.registration_number}` : ""}
            </p>
            {isAdmin && (
              <div className="mt-3 flex gap-2">
                {(["verified", "pending", "rejected"] as const).map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => issuerVerifyMut.mutate({ issuerId: data.issuer!.id, status: s })}
                    className="rounded-md border border-border px-2.5 py-1 text-[11px] capitalize text-muted-foreground hover:text-foreground"
                  >
                    Mark {s}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : canEdit ? (
          <IssuerForm fundingRequestId={fundingRequestId} onSaved={invalidate} />
        ) : (
          <p className="mt-2 text-xs text-muted-foreground">
            No issuer profile has been filed for this project yet.
          </p>
        )}
      </section>

      {/* ---------------- Checklist ---------------- */}
      <section className="card-institutional p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="flex items-center gap-1.5 text-sm font-medium text-foreground">
              <BadgeCheck className="h-3.5 w-3.5" /> Verification checklist
            </h2>
            <p className="mt-1 max-w-xl text-[11px] text-muted-foreground">
              Evidence is filed by the submitter and can only be marked verified by an admin. The
              readiness score counts required items only.
            </p>
          </div>
          <ReadinessMeter score={data?.readiness ?? 0} compact />
        </div>

        <ul className="mt-4 divide-y divide-border">
          {CHECKLIST_ITEMS.map((item) => {
            const row = byKey.get(item.key);
            const status = (row?.status ?? "missing") as ChecklistStatus;
            return (
              <li key={item.key} className="py-3">
                <div className="flex items-start gap-3">
                  <span className="mt-0.5">{STATUS_ICON[status]}</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-foreground">
                      {item.label}
                      {!item.required && (
                        <span className="ml-2 text-[10px] uppercase tracking-widest text-muted-foreground">
                          optional
                        </span>
                      )}
                    </p>
                    <p className="text-[11px] text-muted-foreground">{item.hint}</p>
                    {row?.evidence_url && (
                      <a
                        href={row.evidence_url}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-1 block break-all text-[11px] text-primary underline"
                      >
                        {row.evidence_url}
                      </a>
                    )}
                    {canEdit && (
                      <EvidenceInput
                        defaultValue={row?.evidence_url ?? ""}
                        busy={itemMut.isPending}
                        onSubmit={(url) => itemMut.mutate({ itemKey: item.key, evidenceUrl: url })}
                      />
                    )}
                    {isAdmin && (
                      <div className="mt-2 flex gap-2">
                        <button
                          type="button"
                          onClick={() =>
                            reviewMut.mutate({ itemKey: item.key, status: "verified" })
                          }
                          className="rounded-md border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
                        >
                          Verify
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            reviewMut.mutate({ itemKey: item.key, status: "rejected" })
                          }
                          className="rounded-md border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:text-destructive"
                        >
                          Reject
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
        {err && <p className="mt-3 text-xs text-destructive">{err}</p>}
      </section>

      {/* ---------------- Impact ---------------- */}
      <section className="card-institutional p-5">
        <h2 className="flex items-center gap-1.5 text-sm font-medium text-foreground">
          <Leaf className="h-3.5 w-3.5" /> Impact attestation
        </h2>
        {(data?.attestations.length ?? 0) === 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">
            No published impact attestation for this project yet.
          </p>
        ) : (
          <div className="mt-3 space-y-5">
            {data!.attestations.map((a) => (
              <div key={a.id}>
                <p className="text-sm text-foreground">
                  Attested by {a.attester} · reported {a.reporting_cadence}
                </p>
                <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">
                  {a.methodology}
                </p>
                <div className="mt-3 overflow-x-auto rounded-md border border-border">
                  <table className="w-full min-w-[480px] text-xs">
                    <thead>
                      <tr className="bg-secondary/20 text-left text-muted-foreground">
                        <th className="px-3 py-2 font-normal">Metric</th>
                        <th className="px-3 py-2 font-normal">Unit</th>
                        <th className="px-3 py-2 font-normal">Baseline</th>
                        <th className="px-3 py-2 font-normal">Target</th>
                        <th className="px-3 py-2 font-normal">Method</th>
                      </tr>
                    </thead>
                    <tbody>
                      {a.metrics.map((m) => (
                        <tr key={m.id} className="border-t border-border">
                          <td className="px-3 py-1.5 text-foreground">{m.metric_name}</td>
                          <td className="px-3 py-1.5 text-muted-foreground">{m.unit}</td>
                          <td className="px-3 py-1.5 tabular-nums text-muted-foreground">
                            {m.baseline ?? "—"}
                          </td>
                          <td className="px-3 py-1.5 tabular-nums text-foreground">
                            {m.target ?? "—"}
                          </td>
                          <td className="px-3 py-1.5 text-muted-foreground">
                            {m.measurement_method ?? "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {a.evidence_url && (
                  <a
                    href={a.evidence_url}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-2 block break-all text-[11px] text-primary underline"
                  >
                    {a.evidence_url}
                  </a>
                )}
              </div>
            ))}
          </div>
        )}
        {canEdit && <AttestationForm fundingRequestId={fundingRequestId} onSaved={invalidate} />}
      </section>
    </div>
  );
}

export function VerificationBadge({ status }: { status: string }) {
  const tone =
    status === "verified"
      ? "border-primary/40 text-primary"
      : status === "rejected"
        ? "border-destructive/40 text-destructive"
        : "border-border text-muted-foreground";
  return (
    <span className={`rounded-full border px-2 py-0.5 text-[10px] capitalize ${tone}`}>
      {status === "verified" ? "Verified issuer" : status}
    </span>
  );
}

function EvidenceInput({
  defaultValue,
  busy,
  onSubmit,
}: {
  defaultValue: string;
  busy: boolean;
  onSubmit: (url: string) => void;
}) {
  const [value, setValue] = useState(defaultValue);
  return (
    <div className="mt-2 flex gap-2">
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="https://…"
        className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-[11px] text-foreground"
      />
      <button
        type="button"
        disabled={busy}
        onClick={() => onSubmit(value.trim())}
        className="rounded-md bg-secondary px-2.5 py-1 text-[11px] text-foreground disabled:opacity-50"
      >
        Save
      </button>
    </div>
  );
}

function IssuerForm({
  fundingRequestId,
  onSaved,
}: {
  fundingRequestId: string;
  onSaved: () => void;
}) {
  const save = useServerFn(saveIssuer);
  const [form, setForm] = useState({
    legalName: "",
    jurisdiction: "",
    registrationNumber: "",
    contactEmail: "",
    website: "",
    wrapperType: "spv",
  });
  const mut = useMutation({
    mutationFn: () => save({ data: { ...form, fundingRequestId } }),
    onSuccess: onSaved,
  });

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <div className="mt-3 grid gap-3 sm:grid-cols-2">
      <Field label="Legal entity name" value={form.legalName} onChange={set("legalName")} />
      <Field label="Jurisdiction" value={form.jurisdiction} onChange={set("jurisdiction")} />
      <Field
        label="Registration number"
        value={form.registrationNumber}
        onChange={set("registrationNumber")}
      />
      <Field label="Contact email" value={form.contactEmail} onChange={set("contactEmail")} />
      <Field label="Website (https)" value={form.website} onChange={set("website")} />
      <label className="block">
        <span className="text-[11px] uppercase tracking-widest text-muted-foreground">
          Legal wrapper
        </span>
        <select
          value={form.wrapperType}
          onChange={set("wrapperType")}
          className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
        >
          {["spv", "cooperative", "trust", "company", "foundation", "none"].map((w) => (
            <option key={w} value={w}>
              {w}
            </option>
          ))}
        </select>
      </label>
      <div className="sm:col-span-2">
        <button
          type="button"
          disabled={mut.isPending}
          onClick={() => mut.mutate()}
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {mut.isPending ? "Saving…" : "Save issuer profile"}
        </button>
        {mut.error && (
          <p className="mt-2 flex items-center gap-1.5 text-xs text-destructive">
            <ShieldAlert className="h-3 w-3" /> {(mut.error as Error).message}
          </p>
        )}
      </div>
    </div>
  );
}

function AttestationForm({
  fundingRequestId,
  onSaved,
}: {
  fundingRequestId: string;
  onSaved: () => void;
}) {
  const save = useServerFn(saveImpactAttestation);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    attester: "",
    methodology: "",
    reportingCadence: "quarterly",
    evidenceUrl: "",
  });
  const [metrics, setMetrics] = useState([
    { metricName: "", unit: "", baseline: "", target: "", measurementMethod: "" },
  ]);

  const mut = useMutation({
    mutationFn: () =>
      save({
        data: {
          fundingRequestId,
          attester: form.attester,
          methodology: form.methodology,
          reportingCadence: form.reportingCadence,
          evidenceUrl: form.evidenceUrl || undefined,
          publish: true,
          metrics: metrics.map((m) => ({
            metricName: m.metricName,
            unit: m.unit,
            baseline: m.baseline === "" ? null : Number(m.baseline),
            target: m.target === "" ? null : Number(m.target),
            measurementMethod: m.measurementMethod,
          })),
        },
      }),
    onSuccess: () => {
      setOpen(false);
      onSaved();
    },
  });

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-4 rounded-md border border-border px-3 py-1.5 text-xs text-foreground"
      >
        Publish an impact attestation
      </button>
    );
  }

  return (
    <div className="mt-4 space-y-3 rounded-md border border-border p-4">
      <Field
        label="Attester (who stands behind these numbers)"
        value={form.attester}
        onChange={(e) => setForm((f) => ({ ...f, attester: e.target.value }))}
      />
      <label className="block">
        <span className="text-[11px] uppercase tracking-widest text-muted-foreground">
          Measurement methodology
        </span>
        <textarea
          rows={4}
          value={form.methodology}
          onChange={(e) => setForm((f) => ({ ...f, methodology: e.target.value }))}
          className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
        />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Reporting cadence"
          value={form.reportingCadence}
          onChange={(e) => setForm((f) => ({ ...f, reportingCadence: e.target.value }))}
        />
        <Field
          label="Evidence link (https)"
          value={form.evidenceUrl}
          onChange={(e) => setForm((f) => ({ ...f, evidenceUrl: e.target.value }))}
        />
      </div>

      {metrics.map((m, i) => (
        <div key={i} className="grid gap-2 sm:grid-cols-5">
          {(["metricName", "unit", "baseline", "target", "measurementMethod"] as const).map((k) => (
            <input
              key={k}
              value={m[k]}
              placeholder={k === "metricName" ? "Metric" : k}
              onChange={(e) =>
                setMetrics((rows) =>
                  rows.map((row, idx) => (idx === i ? { ...row, [k]: e.target.value } : row)),
                )
              }
              className="rounded-md border border-border bg-background px-2 py-1 text-[11px] text-foreground"
            />
          ))}
        </div>
      ))}
      <button
        type="button"
        onClick={() =>
          setMetrics((rows) => [
            ...rows,
            { metricName: "", unit: "", baseline: "", target: "", measurementMethod: "" },
          ])
        }
        className="text-[11px] text-primary"
      >
        + add metric
      </button>

      <div className="flex gap-2">
        <button
          type="button"
          disabled={mut.isPending}
          onClick={() => mut.mutate()}
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {mut.isPending ? "Publishing…" : "Publish attestation"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground"
        >
          Cancel
        </button>
      </div>
      {mut.error && <p className="text-xs text-destructive">{(mut.error as Error).message}</p>}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (e: { target: { value: string } }) => void;
}) {
  return (
    <label className="block">
      <span className="text-[11px] uppercase tracking-widest text-muted-foreground">{label}</span>
      <input
        value={value}
        onChange={onChange}
        className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
      />
    </label>
  );
}
