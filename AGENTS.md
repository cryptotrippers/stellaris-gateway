<!-- LOVABLE:BEGIN -->

> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.

<!-- LOVABLE:END -->

- Keep the home-page product overview driven by BRAND and the existing illustrative data modules; this keeps renames and preview figures consistent across pages.
- Scope home-page presentation rules under home-prefixed classes so updates do not restyle the operational app.

- Public marketing pages use `components/layout/MarketingNav` + `MarketingFooter` and the status vocabulary in `components/brand/StatusPill`; keeps navigation and disclosures consistent across pages.
- AI features keep the model call in a `*.server.ts` module behind a `src/routes/api/` route, and the chat surface renders client-only (mounted guard + dynamic import); SSR-painted streaming UI hydrates into a form whose handlers never attach.
- Yield bootstrap screens share the bounded confirmation retry helper in components/deploy and retain submitted results before registration; indexing delays must never cause a second bootstrap transaction or hide seed details.
- Issuer enquiries use colocated validated server functions in components/issuers and a private issuer_leads table with admin-only RLS; this separates B2B contact details from public funding requests and avoids the parallel src/lib workstream.
- The Tessera live dashboard consumes the existing public snapshot without transaction controls; display ratios use bigint arithmetic and browser-only clocks to preserve precision and hydration.
- Project document rooms keep files in the private `project-documents` bucket with no storage policies; every read and write goes through `components/documents` server functions that check issuer ownership or the admin role, with status kept in sidecar JSON beside each file so the database schema and RLS stay unchanged.
- The root ScriptCacheGuard resets queries rather than clearing them; clearing orphans in-flight requests and leaves first-visit pages loading forever.
