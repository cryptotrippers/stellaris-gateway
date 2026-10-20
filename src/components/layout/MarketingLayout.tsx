import type { ReactNode } from "react";
import { MarketingNav } from "./MarketingNav";
import { MarketingFooter } from "./MarketingFooter";

/** Shared public-site chrome: disclosure banner, marketing nav and footer. */
export function MarketingLayout({ children }: { children: ReactNode }) {
  return (
    <div className="home-page min-h-screen bg-background text-foreground">
      <MarketingNav />
      <main className="pb-20 md:pb-0">{children}</main>
      <MarketingFooter />
    </div>
  );
}
