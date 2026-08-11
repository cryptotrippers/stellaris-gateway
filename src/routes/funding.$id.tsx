import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft, ArrowRight, Hammer, Loader2, ShieldCheck, Vote } from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import {
  getFundingRequest,
  proposeFundingForGovernance,
} from "@/lib/funding-requests.functions";
import { getMyRoles } from "@/lib/asset-vaults.functions";
import { useSupabaseUser } from "@/hooks/useSupabaseUser";
import { formatFeeBps, projectApyMatrix } from "@/lib/vault-fees";

const APY_SCENARIOS_BPS = [300, 500, 800, 1200];

export const Route = createFileRoute("/funding/$id")({
  head: ({ params }) => {
    const title = `${params.id} — Funding request | Stellaris`;
    const description = `Issuer, target raise, evidence links, proposed management fee and governance status for the ${params.id} real-world asset funding request on Stellaris.`;
    return {
      meta: [
        { title },
        { name: "description", content: description },
        { property: "og:title", content: title },
        { property: "og:description", content: description },
        { property: "og:type", content: "article" },
        { name: "twitter:card", content: "summary_large_image" },
      ],
    };
  },
  component: FundingRequestDetail,
});

const ada = (lovelace: number) =>
  (lovelace / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 0 });

function FundingRequestDetail() {
  const { id } = Route.useParams();
  const qc = useQueryClient();
  const { user } = useSupabaseUser();
  const propose = useServerFn(proposeFundingForGovernance);

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [newSip, setNewSip] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ["funding-request", id],
    queryFn: () => getFundingRequest({ data: { slug: id } }),
  });

  const rolesQ = useQuery({
    queryKey: ["my-roles"],
    queryFn: () => getMyRoles(),
    retry: 0,
    enabled: Boolean(user),
  });

  const req = q.data ?? null;
  const apyMatrix = useMemo(
    () => (req ? projectApyMatrix(req.proposed_fee_bps, APY_SCENARIOS_BPS) : []),
    [req],
  );
  const isAdmin = (rolesQ.data?.roles ?? []).includes("admin");
  // The row itself never exposes submitted_by publicly; admins always see the
  // action, and the server re-checks ownership for everyone else.
  const canPropose =
    Boolean(user) && Boolean(req) && req?.status === "submitted" && !req?.proposal_id;

  async function onPropose() {
    if (!req) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await propose({ data: { fundingRequestId: req.id } });
      setNewSip(res.sipNumber);
      await qc.invalidateQueries({ queryKey: ["funding-request", id] });
      await qc.invalidateQueries({ queryKey: ["funding-requests"] });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppShell>
      <Link
        to="/funding"
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> All funding requests
      </Link>

      {q.isLoading ? (
        <p className="mt-8 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading request…
        </p>
      ) : q.isError ? (
        <p className="mt-8 text-sm text-destructive">{(q.error as Error).message}</p>
      ) : !req ? (
        <p className="mt-8 text-sm text-muted-foreground">No request found for “{id}”.</p>
      ) : (
        <>
          <div className="mt-4 flex flex-wrap items-start justify-between gap-4">
            <div>
              <h1 className="text-3xl font-semibold tracking-tight text-foreground">{req.name}</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {req.category} · {req.issuer}
                {req.location ? ` · ${req.location}` : ""}
              </p>
            </div>
            <span className="rounded-full border border-border px-2.5 py-0.5 text-[11px] capitalize text-muted-foreground">
              {req.status}
            </span>
          </div>

          {req.description && (
            <p className="mt-6 max-w-3xl whitespace-pre-wrap text-sm text-muted-foreground">
              {req.description}
            </p>
          )}

          <dl className="mt-6 grid gap-4 sm:grid-cols-4">
            <Stat label="Target raise" value={`${ada(req.target_lovelace)} ₳`} />
            <Stat label="Min deposit" value={`${ada(req.min_deposit_lovelace)} ₳`} />
            <Stat label="Proposed fee" value={formatFeeBps(req.proposed_fee_bps)} />
            <Stat label="Identifier" value={req.asset_slug} />
          </dl>

          {req.evidence_urls.length > 0 && (
            <div className="mt-6">
              <h2 className="text-sm font-medium text-foreground">Evidence</h2>
              <ul className="mt-2 space-y-1">
                {req.evidence_urls.map((u) => (
                  <li key={u}>
                    <a
                      href={u}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs text-primary underline break-all"
                    >
                      {u}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <section className="mt-8">
            <h2 className="text-sm font-medium text-foreground">Projected net APY</h2>
            <p className="mt-1 text-[11px] text-muted-foreground">
              Illustrative only, computed with the same fee formula the validator enforces on chain
              at the proposed {formatFeeBps(req.proposed_fee_bps)} management fee.
            </p>
            <div className="mt-3 overflow-x-auto rounded-md border border-border">
              <table className="w-full min-w-[420px] text-xs tabular-nums">
                <thead>
                  <tr className="bg-secondary/20 text-left text-muted-foreground">
                    <th className="px-3 py-2 font-normal">Assumed gross APY</th>
                    <th className="px-3 py-2 font-normal">Management fee</th>
                    <th className="px-3 py-2 font-normal">Net APY to depositors</th>
                  </tr>
                </thead>
                <tbody>
                  {apyMatrix.map((row) => (
                    <tr key={row.grossApyBps} className="border-t border-border">
                      <td className="px-3 py-1.5 text-foreground">
                        {formatFeeBps(row.grossApyBps)}
                      </td>
                      <td className="px-3 py-1.5 text-muted-foreground">
                        {formatFeeBps(req.proposed_fee_bps)}
                      </td>
                      <td className="px-3 py-1.5 font-medium text-foreground">
                        {formatFeeBps(row.netApyBps)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {req.terms_accepted_at && (
            <p className="mt-4 flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <ShieldCheck className="h-3 w-3" /> Submitter accepted{" "}
              <Link to="/terms" className="text-primary underline">
                platform terms {req.terms_version}
              </Link>{" "}
              on {new Date(req.terms_accepted_at).toLocaleDateString()}.
            </p>
          )}

          <section className="card-institutional mt-8 p-5">
            <h2 className="text-sm font-medium text-foreground">Governance</h2>

            {newSip ? (
              <p className="mt-2 text-sm text-foreground">
                Proposed as <span className="font-semibold">{newSip}</span>.{" "}
                <Link
                  to="/governance/$sip"
                  params={{ sip: newSip }}
                  className="inline-flex items-center gap-1 text-primary"
                >
                  Open the proposal <ArrowRight className="h-3 w-3" />
                </Link>
              </p>
            ) : req.status === "asset_created" ? (
              <p className="mt-2 text-sm text-muted-foreground">
                Governance passed and an asset row now exists. See “Smart contract” below for what
                happens next.
              </p>
            ) : req.proposal_id ? (
              <p className="mt-2 text-sm text-muted-foreground">
                This request is already linked to a governance proposal.{" "}
                <Link to="/governance" className="text-primary">
                  View governance
                </Link>
              </p>
            ) : req.status !== "submitted" ? (
              <p className="mt-2 text-sm text-muted-foreground">
                This request is “{req.status}” and can no longer be proposed automatically.
              </p>
            ) : !user ? (
              <p className="mt-2 text-sm text-muted-foreground">
                Sign in as the submitter or an admin to propose this for a vote.
              </p>
            ) : (
              <>
                <p className="mt-2 text-sm text-muted-foreground">
                  Promoting this request creates a <code>fund_asset</code> proposal with the exact
                  terms above, read fresh from this record.
                  {isAdmin ? " You hold the admin role." : ""}
                </p>
                <button
                  type="button"
                  onClick={onPropose}
                  disabled={busy || !canPropose}
                  className="mt-4 inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
                >
                  {busy ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Vote className="h-4 w-4" />
                  )}
                  Propose for governance vote
                </button>
              </>
            )}

            {err && <p className="mt-3 text-sm text-destructive">{err}</p>}
          </section>

          <section className="card-institutional mt-6 p-5">
            <h2 className="flex items-center gap-1.5 text-sm font-medium text-foreground">
              <Hammer className="h-3.5 w-3.5" /> Smart contract
            </h2>
            {req.status === "asset_created" ? (
              <p className="mt-2 text-sm text-muted-foreground">
                The <code>{req.asset_slug}</code> asset row exists, but no vault has been derived
                for it yet. An operator bootstraps the on-chain vault next, writing this request's
                approved fee terms into its state datum.{" "}
                <Link to="/operators" className="inline-flex items-center gap-1 text-primary">
                  Open the operator console <ArrowRight className="h-3 w-3" />
                </Link>
              </p>
            ) : req.proposal_id ? (
              <p className="mt-2 text-sm text-muted-foreground">
                No vault exists yet. If the linked proposal passes, an asset row is created and
                bootstrap becomes available in the operator console — nothing on chain happens
                automatically.
              </p>
            ) : (
              <p className="mt-2 text-sm text-muted-foreground">
                No vault can exist until this request becomes a governance proposal and that
                proposal passes.
              </p>
            )}
          </section>
        </>
      )}
    </AppShell>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="card-institutional p-4">
      <dt className="text-[10px] uppercase tracking-widest text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-sm tabular-nums text-foreground">{value}</dd>
    </div>
  );
}
