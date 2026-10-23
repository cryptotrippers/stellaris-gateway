/**
 * Signed-in destinations grouped by audience. Showing or hiding a group is a
 * convenience only: each page and server function enforces access itself.
 * Every `to` must be an existing route; `hash` targets an in-page section.
 */
export type AccountLink = { label: string; to: string; hash?: string };
export type AccountGroup = { title: string; links: AccountLink[] };

export const INVESTOR_LINKS: AccountGroup = {
  title: "Investor",
  links: [
    { label: "Dashboard", to: "/app" },
    { label: "My Investments", to: "/app", hash: "assets" },
    { label: "Transactions", to: "/app", hash: "transactions" },
    { label: "Distributions", to: "/app", hash: "distributions" },
    { label: "Documents", to: "/app", hash: "documents" },
    { label: "Governance", to: "/governance" },
    { label: "Account", to: "/security" },
  ],
};

export const ISSUER_LINKS: AccountGroup = {
  title: "Issuer",
  links: [
    { label: "Issuer Dashboard", to: "/issuer" },
    { label: "Funding Requests", to: "/funding" },
    { label: "Data Room", to: "/issuer", hash: "data-room" },
    { label: "Review Progress", to: "/issuer", hash: "journey" },
    { label: "Reports", to: "/issuer", hash: "reports" },
  ],
};

export const ADMIN_LINKS: AccountGroup = {
  title: "Administrator",
  links: [
    { label: "Issuer Applications", to: "/issuer-leads" },
    { label: "Due Diligence", to: "/funding" },
    { label: "Review Queue", to: "/governance" },
    { label: "Funding Pipeline", to: "/pipeline" },
    { label: "Approved Offerings", to: "/offerings" },
    { label: "Operations", to: "/operators" },
  ],
};

export function accountGroups(isAdmin: boolean): AccountGroup[] {
  return isAdmin ? [INVESTOR_LINKS, ISSUER_LINKS, ADMIN_LINKS] : [INVESTOR_LINKS, ISSUER_LINKS];
}
