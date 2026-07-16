import { createFileRoute } from "@tanstack/react-router";
import type {} from "@tanstack/react-start";
import { ASSETS } from "@/lib/mock-data";

const BASE_URL = "";

export const Route = createFileRoute("/sitemap.xml")({
  server: {
    handlers: {
      GET: async () => {
        const govTabs = ["overview", "proposals", "vaults", "delegates", "signals"];
        const entries = [
          { path: "/", priority: "1.0", changefreq: "daily" as const },
          { path: "/app", priority: "0.7", changefreq: "daily" as const },
          { path: "/marketplace", priority: "0.9", changefreq: "hourly" as const },
          { path: "/yield", priority: "0.8", changefreq: "daily" as const },
          { path: "/governance", priority: "0.8", changefreq: "hourly" as const },
          ...govTabs.map(t => ({ path: `/governance?tab=${t}`, priority: "0.6", changefreq: "hourly" as const })),
          { path: "/governance/new", priority: "0.5", changefreq: "monthly" as const },
          { path: "/stewardship", priority: "0.6", changefreq: "weekly" as const },
          { path: "/security", priority: "0.5", changefreq: "monthly" as const },
          { path: "/developers", priority: "0.6", changefreq: "weekly" as const },
          { path: "/upgrade", priority: "0.8", changefreq: "weekly" as const },
          ...ASSETS.map(a => ({ path: `/marketplace/${a.id}`, priority: "0.7", changefreq: "daily" as const })),
        ];
        const urls = entries.map(e => `  <url>\n    <loc>${BASE_URL}${e.path}</loc>\n    <changefreq>${e.changefreq}</changefreq>\n    <priority>${e.priority}</priority>\n  </url>`);
        const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>`;
        return new Response(xml, { headers: { "Content-Type": "application/xml", "Cache-Control": "public, max-age=3600" } });
      },
    },
  },
});
