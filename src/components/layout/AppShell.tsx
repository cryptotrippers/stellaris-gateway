import type { ReactNode } from "react";
import { TopAppBar } from "./TopAppBar";
import { BottomNavBar } from "./BottomNavBar";

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-background">
      <div className="pointer-events-none fixed inset-x-0 top-0 h-[420px] bg-gradient-hero" />
      <TopAppBar />
      <main className="relative mx-auto max-w-[1400px] px-4 pb-28 pt-6 md:px-6 md:pb-12">
        {children}
      </main>
      <BottomNavBar />
    </div>
  );
}
