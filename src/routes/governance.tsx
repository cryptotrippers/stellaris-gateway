import { createFileRoute, Outlet } from "@tanstack/react-router";
import { MarketingLayout } from "@/components/layout/MarketingLayout";

export const Route = createFileRoute("/governance")({
  component: () => (
    <MarketingLayout>
      <Outlet />
    </MarketingLayout>
  ),
});
