import type { DisclosureStatus } from "@/components/brand/StatusPill";

/**
 * The Stellaris Clarity Standard: seven disclosures every project is measured
 * against. Statuses are derived only from stored fields. A published document
 * is never shown as "verified" — verification needs a recorded independent
 * review, which no data source provides yet.
 */
export type ClarityKey =
  | "legal_rights"
  | "issuer_identity"
  | "asset_verification"
  | "financial_disclosures"
  | "fees_expenses"
  | "liquidity_exit"
  | "risks";

export type ClarityItem = { key: ClarityKey; label: string; status: DisclosureStatus; note: string };

export type ClarityInput = {
  funding_status: string;
  issuer: string;
  description: string | null;
  audit_report_url: string | null;
  /** True when a vault for this asset is registered with a bootstrap transaction. */
  vaultLive?: boolean;
};

export function clarityItems(a: ClarityInput): ClarityItem[] {
  const demo = a.funding_status === "demo";
  const hasIssuer = a.issuer.trim().length > 0;
  return [
    {
      key: "legal_rights",
      label: "Legal rights",
      status: demo ? "not_applicable" : "pending",
      note: demo
        ? "Demo listing — no rights are offered."
        : "No legal wrapper or unit-holder rights document is on file.",
    },
    {
      key: "issuer_identity",
      label: "Issuer identity",
      status: demo ? "illustrative" : hasIssuer ? "published" : "pending",
      note: demo
        ? "The issuer named on this demo is illustrative."
        : hasIssuer
          ? "Issuer name is published; no independent identity check is recorded."
          : "Issuer has not been named.",
    },
    {
      key: "asset_verification",
      label: "Asset verification",
      status: demo ? "not_applicable" : a.audit_report_url ? "published" : "pending",
      note: a.audit_report_url
        ? "A report link is published; it has not been independently confirmed by Stellaris."
        : demo
          ? "Demo listing — there is no real asset to verify."
          : "No asset verification report is on file.",
    },
    {
      key: "financial_disclosures",
      label: "Financial disclosures",
      status: demo ? "illustrative" : "pending",
      note: demo
        ? "Figures on this demo are illustrative."
        : "Only target and minimum are stored; no financial statements are on file.",
    },
    {
      key: "fees_expenses",
      label: "Fees and expenses",
      status: demo ? "not_applicable" : "pending",
      note: demo
        ? "Demo listing — no fees apply."
        : "Project fees are not published. Any network fee is shown in your wallet before signing.",
    },
    {
      key: "liquidity_exit",
      label: "Liquidity and exit",
      status: demo ? "not_applicable" : a.vaultLive ? "published" : "pending",
      note: demo
        ? "Demo listing — nothing to exit."
        : a.vaultLive
          ? "Withdrawal rules are enforced by the public on-chain vault contract (unaudited)."
          : "No live vault yet, so no exit rules apply.",
    },
    {
      key: "risks",
      label: "Risks",
      status: "published",
      note: "Standard testnet, contract, issuer, legal and liquidity risks are listed on this page.",
    },
  ];
}

/** Number of items that have at least a published disclosure. */
export function clarityPublishedCount(items: ClarityItem[]): number {
  return items.filter((i) => i.status === "published" || i.status === "verified").length;
}
