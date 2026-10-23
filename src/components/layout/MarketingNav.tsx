import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { ArrowUpRight, Menu, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StellarisWordmark } from "@/components/brand/Logo";
import { DisclosureBanner } from "@/components/brand/DisclosureBanner";
import { BRAND } from "@/config/brand";
import { trackEvent } from "@/lib/analytics";

const LINKS = [
  { to: "/marketplace", label: "Explore Assets" },
  { to: "/how-it-works", label: "How It Works" },
  { to: "/tessera", label: BRAND.productName },
  { to: "/transparency", label: "Transparency" },
  { to: "/for-issuers", label: "For Issuers" },
  { to: "/learn", label: "Learn" },
  { to: "/about", label: "About" },
] as const;

/** Public marketing navigation. Protocol/admin links live in the app's own menu. */
export function MarketingNav() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <DisclosureBanner />
      <header className="sticky top-0 z-30 border-b border-border bg-surface/95 backdrop-blur-md">
        <div className="home-container flex h-[68px] items-center justify-between gap-3">
          <Link to="/" aria-label="Stellaris home" className="shrink-0">
            <StellarisWordmark />
          </Link>
          <nav aria-label="Main navigation" className="hidden items-center gap-5 md:flex lg:gap-7">
            {LINKS.map((l) => (
              <Link
                key={l.to}
                to={l.to}
                className="text-sm font-medium text-muted-foreground transition-colors hover:text-primary"
                activeProps={{ className: "text-primary" }}
              >
                {l.label}
              </Link>
            ))}
          </nav>
          <div className="flex items-center gap-2">
            <Button asChild className="hidden h-10 px-5 md:inline-flex">
              <Link to="/app" onClick={() => trackEvent("explore_demo", { from: "nav" })}>
                Explore the Demo <ArrowUpRight />
              </Link>
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="md:hidden"
              aria-label={open ? "Close menu" : "Open menu"}
              aria-expanded={open}
              aria-controls="marketing-mobile-menu"
              onClick={() => setOpen(!open)}
            >
              {open ? <X /> : <Menu />}
            </Button>
          </div>
        </div>
        {open && (
          <nav
            id="marketing-mobile-menu"
            aria-label="Mobile navigation"
            className="home-container grid gap-1 border-t border-border py-3 md:hidden"
          >
            {LINKS.map((l) => (
              <Button key={l.to} asChild variant="ghost" className="justify-start">
                <Link to={l.to} onClick={() => setOpen(false)}>
                  {l.label}
                </Link>
              </Button>
            ))}
          </nav>
        )}
      </header>
      {/* Persistent, unobtrusive mobile CTA */}
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-surface/95 p-3 backdrop-blur-md md:hidden">
        <Button asChild className="h-11 w-full">
          <Link to="/app" onClick={() => trackEvent("explore_demo", { from: "mobile_bar" })}>
            Explore the Demo <ArrowUpRight />
          </Link>
        </Button>
      </div>
    </>
  );
}
