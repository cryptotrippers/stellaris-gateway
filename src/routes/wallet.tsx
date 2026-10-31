import { createFileRoute } from "@tanstack/react-router";
import { AccountFrame } from "@/components/auth/AccountFrame";
import { WalletConnectionPanel } from "@/components/wallet/WalletConnectionPanel";
export const Route = createFileRoute("/wallet")({
  component: WalletPage,
  head: () => ({
    meta: [
      { title: "Connect your wallet · Stellaris Finance" },
      {
        name: "description",
        content:
          "Manage your Cardano Preprod wallet connection separately from your Stellaris account.",
      },
      { property: "og:title", content: "Connect your wallet · Stellaris Finance" },
      {
        property: "og:description",
        content: "Connect a browser or configured mobile wallet, or view an address read-only.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
});
function WalletPage() {
  return (
    <AccountFrame
      title="Your wallet, connected"
      subtitle="Choose a Cardano wallet for the Preprod experience. You stay in control of every signature."
    >
      <h2 className="mb-5 text-xl font-semibold tracking-normal">Wallet connection</h2>
      <WalletConnectionPanel />
    </AccountFrame>
  );
}
