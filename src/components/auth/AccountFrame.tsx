import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, ShieldCheck, Wallet } from "lucide-react";
import { StellarisWordmark } from "@/components/brand/Logo";
import { Button } from "@/components/ui/button";

export function AccountFrame({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-5 sm:px-6">
          <Link to="/" aria-label="Stellaris home">
            <StellarisWordmark />
          </Link>
          <Button asChild variant="ghost" className="min-h-11">
            <Link to="/marketplace">
              <ArrowLeft /> Explore assets
            </Link>
          </Button>
        </div>
      </header>
      <main className="mx-auto grid max-w-6xl gap-8 px-4 py-10 sm:px-6 sm:py-16 lg:grid-cols-[1fr_1fr] lg:gap-20">
        <section className="protocol relative overflow-hidden rounded-lg border border-border bg-deep p-5 text-deep-foreground sm:p-10">
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-aqua">
            <ShieldCheck className="h-4 w-4" /> Stellaris account
          </div>
          <h1 className="mt-4 text-3xl font-semibold tracking-normal sm:mt-7 sm:text-4xl">{title}</h1>
          <p className="mt-4 max-w-md text-sm leading-7 text-deep-foreground/80">{subtitle}</p>
          <div className="mt-5 border-t border-border pt-4 sm:mt-10 sm:pt-6">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Wallet className="h-5 w-5 text-aqua" /> Your account. Your wallet. Separate.
            </div>
            <p className="mt-3 hidden text-sm leading-6 text-deep-foreground/80 sm:block">
              Signing in does not connect a wallet or grant administrator access. Connecting a
              wallet does not prove ownership to your account.
            </p>
            <p className="mt-6 text-xs leading-6 text-gold">
              Cardano Preprod only · Test assets have no monetary value. No real-money investments
              are available.
            </p>
          </div>
        </section>
        <section aria-label={title} className="min-w-0 self-center py-2">
          {children}
        </section>
      </main>
      <footer className="mx-auto flex max-w-6xl flex-wrap gap-5 px-4 pb-8 text-xs text-muted-foreground sm:px-6">
        <Link to="/trust" className="inline-flex min-h-11 items-center hover:text-primary">
          Trust Centre
        </Link>
        <Link to="/terms" className="inline-flex min-h-11 items-center hover:text-primary">
          Terms & disclosures
        </Link>
      </footer>
    </div>
  );
}
