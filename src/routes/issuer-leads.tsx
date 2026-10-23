import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Search, Save, Loader2, RefreshCw } from "lucide-react";
import { MarketingLayout } from "@/components/layout/MarketingLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { useSupabaseUser } from "@/hooks/useSupabaseUser";
import { LEAD_STATUSES } from "@/components/issuers/lead-schema";
import { listIssuerLeads, updateIssuerLead } from "@/components/issuers/leads.functions";

export const Route = createFileRoute("/issuer-leads")({
  head: () => ({ meta: [
    { title: "Issuer Enquiry Management · Stellaris" },
    { name: "description", content: "Private administrator workspace for reviewing Stellaris issuer enquiries." },
    { property: "og:title", content: "Issuer Enquiry Management · Stellaris" },
    { property: "og:description", content: "Administrator-only issuer enquiry workspace." },
    { property: "og:type", content: "website" }, { name: "twitter:card", content: "summary" },
    { name: "robots", content: "noindex, nofollow" },
  ] }), component: IssuerLeadsPage,
});

type Lead = NonNullable<Awaited<ReturnType<typeof listIssuerLeads>>>[number];

function IssuerLeadsPage() {
  const { user, loading } = useSupabaseUser();
  const q = useQuery({ queryKey: ["issuer-leads", user?.id], queryFn: () => listIssuerLeads(), enabled: Boolean(user) });
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const rows = (q.data ?? []).filter(r => (status === "all" || r.status === status) && `${r.organization} ${r.contact_name} ${r.email} ${r.jurisdiction}`.toLowerCase().includes(search.toLowerCase()));
  return <MarketingLayout><div className="home-container home-section">
    <Link to="/for-issuers" className="text-sm text-teal">← For Issuers</Link>
    <h1 className="mt-5 text-3xl font-semibold">Issuer enquiries</h1>
    <p className="mt-2 text-sm text-muted-foreground">Private administrator workspace · newest first</p>
    {loading ? <p className="mt-8">Checking your session…</p> : !user ? <div className="mt-8"><p>Sign in with an administrator account to review enquiries.</p><Button asChild className="mt-4"><Link to="/auth">Sign in</Link></Button></div> : q.isPending ? <p className="mt-8">Loading enquiries…</p> : q.isError ? <p role="alert" className="mt-8 text-destructive">{q.error.message}</p> : <>
      <div className="mt-8 flex flex-wrap items-end gap-3"><div className="min-w-0 flex-1 space-y-2"><Label htmlFor="lead-search">Search enquiries</Label><div className="relative"><Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" /><Input id="lead-search" value={search} onChange={e => setSearch(e.target.value)} className="pl-9" placeholder="Organisation, contact or jurisdiction" /></div></div><div className="space-y-2"><Label htmlFor="lead-filter">Status</Label><select id="lead-filter" value={status} onChange={e => setStatus(e.target.value)} className="h-10 rounded-md border border-input bg-background px-3 text-sm"><option value="all">All statuses</option>{LEAD_STATUSES.map(s => <option key={s}>{s}</option>)}</select></div><Button size="icon" variant="outline" aria-label="Refresh enquiries" onClick={() => q.refetch()}><RefreshCw /></Button></div>
      <p className="mt-4 text-xs text-muted-foreground">{rows.length} shown · {q.data?.length ?? 0} enquiries loaded (latest 500)</p>
      {rows.length === 0 ? <p className="mt-10 border-t border-border pt-6 text-muted-foreground">No enquiries match this view.</p> : <div className="mt-6 space-y-5">{rows.map(r => <LeadEditor key={`${r.id}-${r.updated_at}`} lead={r} />)}</div>}
    </>}
  </div></MarketingLayout>;
}

function LeadEditor({lead}: {lead: Lead}) {
  const cache = useQueryClient();
  const [status,setStatus] = useState(lead.status);
  const [notes,setNotes] = useState(lead.internal_notes);
  const [pending,setPending] = useState(false);
  const [message,setMessage] = useState("");
  async function save() {
    setPending(true); setMessage("");
    try { await updateIssuerLead({data:{id:lead.id,status:status as typeof LEAD_STATUSES[number],internal_notes:notes}}); setMessage("Saved."); await cache.invalidateQueries({queryKey:["issuer-leads"]}); }
    catch(e) {setMessage(e instanceof Error ? e.message : "Could not save.");}
    finally {setPending(false);}
  }
  return <article className="rounded-lg border border-border bg-surface p-5 md:p-6">
    <div className="flex flex-wrap justify-between gap-3"><div><h2 className="text-lg font-semibold">{lead.organization}</h2><p className="mt-1 text-sm text-muted-foreground">{lead.asset_category} · {lead.jurisdiction}</p></div><time className="text-xs text-muted-foreground">{new Date(lead.created_at).toLocaleString()}</time></div>
    <p className="mt-4 break-words text-sm">{lead.contact_name} · <a className="text-teal underline" href={`mailto:${lead.email}`}>{lead.email}</a></p>
    <p className="mt-4 whitespace-pre-wrap break-words text-sm leading-relaxed text-muted-foreground">{lead.project_summary}</p>
    <div className="mt-5 grid gap-4 border-t border-border pt-5 md:grid-cols-[180px_1fr]"><div className="space-y-2"><Label htmlFor={`status-${lead.id}`}>Review status</Label><select id={`status-${lead.id}`} value={status} onChange={e => setStatus(e.target.value)} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">{LEAD_STATUSES.map(s => <option key={s}>{s}</option>)}</select></div><div className="space-y-2"><Label htmlFor={`notes-${lead.id}`}>Internal notes</Label><Textarea id={`notes-${lead.id}`} value={notes} onChange={e => setNotes(e.target.value)} maxLength={5000} rows={3} /></div></div>
    <div className="mt-4 flex items-center gap-3"><Button disabled={pending} onClick={save}>{pending ? <Loader2 className="animate-spin" /> : <Save />} Save changes</Button><p role="status" className="text-sm text-muted-foreground">{message}</p></div>
  </article>;
}