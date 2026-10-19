import { Link } from "@tanstack/react-router";
import { StellarisWordmark } from "@/components/brand/Logo";
import { BRAND } from "@/config/brand";

type Col = { title: string; links: [string, string][] };

const COLS: Col[] = [
  {
    title: "Products",
    links: [
      ["Real-world assets", "/marketplace"],
      ["Fractions", "/offerings"],
      [BRAND.productName, "/stake"],
      ["Property (planned)", "/property"],
    ],
  },
  {
    title: "Transparency",
    links: [
      ["Reserve model", "/transparency"],
      ["Security", "/security"],
      ["Governance", "/governance"],
      ["Network status", "/blockfrost-health"],
    ],
  },
  {
    title: "Learn & build",
    links: [
      ["Learn", "/learn"],
      ["Developers", "/developers"],
      ["For Issuers", "/funding"],
    ],
  },
  {
    title: "Company",
    links: [
      ["About", "/about"],
      ["Terms & risk", "/terms"],
    ],
  },
];

export function MarketingFooter() {
  return (
    <footer className="protocol pb-20 md:pb-0">
      <div className="home-container grid gap-10 py-14 sm:grid-cols-2 lg:grid-cols-[1.4fr_repeat(4,1fr)]">
        <div>
          <StellarisWordmark inverted />
          <p className="mt-4 max-w-xs text-sm leading-relaxed text-muted-foreground">
            The transparent gateway to real-world assets on Cardano.
          </p>
          <p className="mt-4 inline-flex items-center gap-2 rounded-full border border-border px-3 py-1 text-xs text-muted-foreground">
            <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden="true" />
            Network: Cardano Preprod (testnet)
          </p>
        </div>
        {COLS.map((c) => (
          <div key={c.title}>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{c.title}</h3>
            <ul className="mt-4 space-y-3">
              {c.links.map(([label, to]) => (
                <li key={to}>
                  <Link to={to} className="text-sm text-foreground/90 transition-colors hover:text-aqua">
                    {label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="home-container flex flex-wrap justify-between gap-3 border-t border-border py-5 text-xs text-muted-foreground">
        <span>© {new Date().getUTCFullYear()} Stellaris Finance. Built on Cardano.</span>
        <span>
          Testnet preview. No real-money investments are available. Capital would be at risk; nothing is
          guaranteed.
        </span>
      </div>
    </footer>
  );
}
