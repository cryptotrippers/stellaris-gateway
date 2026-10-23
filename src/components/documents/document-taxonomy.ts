/**
 * Project document sections and classifications, chosen by project type.
 *
 * Each category may name the verification checklist item it supports, so
 * reviewers can see which check a document is evidence for. Supporting a
 * check never verifies it: checklist decisions stay with administrators.
 */

export type ProjectType =
  | "renewables"
  | "real_estate"
  | "private_credit"
  | "infrastructure"
  | "other";

export type ChecklistKey =
  | "legal_wrapper"
  | "asset_title"
  | "operating_licence"
  | "insurance"
  | "offtake_agreement"
  | "technical_audit"
  | "impact_methodology";

export interface DocumentCategory {
  key: string;
  label: string;
  hint: string;
  supports?: ChecklistKey;
}

export interface DocumentSection {
  key: string;
  label: string;
  description: string;
  categories: DocumentCategory[];
}

export const PROJECT_TYPE_LABEL: Record<ProjectType, string> = {
  renewables: "Renewable energy",
  real_estate: "Real estate",
  private_credit: "Private credit",
  infrastructure: "Infrastructure",
  other: "Other real-world asset",
};

/** Maps the free-text project category to a document profile. Unknown values fall back to "other". */
export function projectTypeOf(category: string | null | undefined): ProjectType {
  const c = (category ?? "").toLowerCase();
  if (/renew|solar|wind|hydro|energy|battery|geotherm/.test(c)) return "renewables";
  if (/real estate|real-estate|property|housing|residential|commercial|building/.test(c))
    return "real_estate";
  if (/credit|loan|lending|debt|receivable|invoice/.test(c)) return "private_credit";
  if (/infra|transport|water|telecom|utility|road|port/.test(c)) return "infrastructure";
  return "other";
}

const CORPORATE: DocumentSection = {
  key: "corporate",
  label: "Corporate and legal",
  description: "Who the issuer is and what investors would legally hold.",
  categories: [
    {
      key: "constitutional",
      label: "Constitutional documents",
      hint: "Certificate of incorporation, articles, SPV or trust deed.",
      supports: "legal_wrapper",
    },
    {
      key: "legal_opinion",
      label: "Legal opinion",
      hint: "Independent counsel's opinion on the structure.",
      supports: "legal_wrapper",
    },
    {
      key: "offering_terms",
      label: "Offering terms and investor rights",
      hint: "Term sheet, subscription or participation agreement.",
    },
  ],
};

const FINANCIAL: DocumentSection = {
  key: "financial",
  label: "Financial information",
  description: "Accounts, budgets and the model behind the projected cash flows.",
  categories: [
    {
      key: "financial_statements",
      label: "Financial statements",
      hint: "Audited or management accounts.",
    },
    {
      key: "financial_model",
      label: "Financial model and budget",
      hint: "Revenue, operating cost and financing assumptions.",
    },
    {
      key: "tax_regulatory",
      label: "Tax and regulatory filings",
      hint: "Registrations, returns and regulator correspondence.",
    },
  ],
};

const INSURANCE: DocumentSection = {
  key: "insurance",
  label: "Insurance",
  description: "Cover for the asset, its operation and liabilities.",
  categories: [
    {
      key: "insurance_policy",
      label: "Insurance policies and certificates",
      hint: "Policy schedules showing insurer, cover and expiry.",
      supports: "insurance",
    },
  ],
};

const REPORTING: DocumentSection = {
  key: "reporting",
  label: "Reporting",
  description: "Periodic reports once the project is running.",
  categories: [
    {
      key: "operating_report",
      label: "Operating and investor reports",
      hint: "Monthly, quarterly or annual performance reports.",
    },
  ],
};

const OTHER: DocumentSection = {
  key: "other",
  label: "Other supporting documents",
  description: "Anything relevant that does not fit another section.",
  categories: [
    {
      key: "other_supporting",
      label: "Other supporting document",
      hint: "Describe what it shows in the title.",
    },
  ],
};

const IMPACT: DocumentSection = {
  key: "impact",
  label: "Impact",
  description: "How environmental or social outcomes are measured.",
  categories: [
    {
      key: "impact_methodology",
      label: "Impact methodology and measurement",
      hint: "Baseline, metrics and who measures them.",
      supports: "impact_methodology",
    },
  ],
};

const SPECIFIC: Record<ProjectType, DocumentSection[]> = {
  renewables: [
    {
      key: "asset_ownership",
      label: "Site and ownership",
      description: "Rights to the site and ownership of the generating equipment.",
      categories: [
        {
          key: "site_rights",
          label: "Land lease or site rights",
          hint: "Lease, easement or rooftop agreement.",
          supports: "asset_title",
        },
        {
          key: "equipment_ownership",
          label: "Equipment ownership and warranties",
          hint: "Purchase invoices, bills of sale, manufacturer warranties.",
          supports: "asset_title",
        },
      ],
    },
    {
      key: "permits",
      label: "Permits and licences",
      description: "Permission to build, connect and generate.",
      categories: [
        {
          key: "generation_licence",
          label: "Generation licence",
          hint: "Licence or registration to generate and sell power.",
          supports: "operating_licence",
        },
        {
          key: "environmental_permit",
          label: "Environmental and planning permits",
          hint: "Planning consent and environmental approvals.",
          supports: "operating_licence",
        },
        {
          key: "grid_connection",
          label: "Grid connection agreement",
          hint: "Agreement with the network operator.",
          supports: "operating_licence",
        },
      ],
    },
    {
      key: "technical",
      label: "Technical",
      description: "Independent view of expected output and asset condition.",
      categories: [
        {
          key: "energy_yield",
          label: "Energy yield assessment",
          hint: "P50/P90 production estimate from an independent engineer.",
          supports: "technical_audit",
        },
        {
          key: "technical_dd",
          label: "Independent technical due diligence",
          hint: "Engineer's report on design, construction and condition.",
          supports: "technical_audit",
        },
        {
          key: "om_agreement",
          label: "Operations and maintenance agreement",
          hint: "Who maintains the asset and on what terms.",
        },
      ],
    },
    {
      key: "revenue",
      label: "Revenue contracts",
      description: "Where the income comes from.",
      categories: [
        {
          key: "ppa",
          label: "Power purchase agreement",
          hint: "Offtaker, tariff, term and termination rights.",
          supports: "offtake_agreement",
        },
      ],
    },
    IMPACT,
  ],
  real_estate: [
    {
      key: "asset_ownership",
      label: "Title and ownership",
      description: "Legal title to the property and anything secured against it.",
      categories: [
        {
          key: "title_deed",
          label: "Title deed or land registry extract",
          hint: "Current registry extract naming the owner.",
          supports: "asset_title",
        },
        {
          key: "encumbrances",
          label: "Charges and encumbrance search",
          hint: "Mortgages, liens and easements on the title.",
          supports: "asset_title",
        },
      ],
    },
    {
      key: "valuation",
      label: "Valuation",
      description: "Independent opinion of the property's value.",
      categories: [
        {
          key: "valuation_report",
          label: "Independent valuation report",
          hint: "Valuer, method, date and value.",
        },
      ],
    },
    {
      key: "permits",
      label: "Permits and compliance",
      description: "Permission to build and occupy, and environmental status.",
      categories: [
        {
          key: "building_permits",
          label: "Building and occupancy permits",
          hint: "Planning, building and occupancy approvals.",
          supports: "operating_licence",
        },
        {
          key: "environmental_survey",
          label: "Environmental survey",
          hint: "Contamination, flood and energy performance.",
        },
      ],
    },
    {
      key: "technical",
      label: "Building condition",
      description: "Independent survey of the building's condition.",
      categories: [
        {
          key: "building_survey",
          label: "Building condition survey",
          hint: "Surveyor's report with repair liabilities.",
          supports: "technical_audit",
        },
      ],
    },
    {
      key: "revenue",
      label: "Leases and income",
      description: "Tenancies and who manages them.",
      categories: [
        {
          key: "leases",
          label: "Lease agreements",
          hint: "Signed leases with rent and term.",
          supports: "offtake_agreement",
        },
        {
          key: "rent_roll",
          label: "Rent roll and occupancy schedule",
          hint: "Tenants, rents, arrears and expiries.",
          supports: "offtake_agreement",
        },
        {
          key: "property_management",
          label: "Property management agreement",
          hint: "Manager, fees and responsibilities.",
        },
      ],
    },
  ],
  private_credit: [
    {
      key: "loan",
      label: "Loan documentation",
      description: "The lending contract and the security behind it.",
      categories: [
        {
          key: "facility_agreement",
          label: "Facility or loan agreement",
          hint: "Principal, rate, term and covenants.",
          supports: "offtake_agreement",
        },
        {
          key: "security_package",
          label: "Security and collateral documents",
          hint: "Charges, guarantees and collateral registers.",
          supports: "asset_title",
        },
      ],
    },
    {
      key: "credit",
      label: "Borrower credit",
      description: "Evidence of the borrower's ability to repay.",
      categories: [
        {
          key: "borrower_financials",
          label: "Borrower financial statements",
          hint: "Borrower accounts and cash-flow statements.",
        },
        {
          key: "credit_memo",
          label: "Credit assessment",
          hint: "Independent or internal credit analysis.",
          supports: "technical_audit",
        },
      ],
    },
    {
      key: "servicing",
      label: "Servicing",
      description: "Who collects repayments and how performance is reported.",
      categories: [
        {
          key: "servicing_agreement",
          label: "Servicing agreement",
          hint: "Servicer, fees and reporting duties.",
        },
        {
          key: "loan_tape",
          label: "Loan tape and performance report",
          hint: "Repayments, arrears and defaults to date.",
        },
      ],
    },
    {
      key: "permits",
      label: "Licences",
      description: "Permission to lend or service loans.",
      categories: [
        {
          key: "lending_licence",
          label: "Lending or servicing licence",
          hint: "Regulator licence or exemption.",
          supports: "operating_licence",
        },
      ],
    },
  ],
  infrastructure: [
    {
      key: "asset_ownership",
      label: "Concession and ownership",
      description: "The right to build, own or operate the asset.",
      categories: [
        {
          key: "concession",
          label: "Concession or project agreement",
          hint: "Grantor, term, hand-back and termination terms.",
          supports: "asset_title",
        },
        {
          key: "land_rights",
          label: "Land and access rights",
          hint: "Leases, wayleaves and access agreements.",
          supports: "asset_title",
        },
      ],
    },
    {
      key: "permits",
      label: "Permits",
      description: "Permission to build and operate.",
      categories: [
        {
          key: "operating_permits",
          label: "Operating permits and licences",
          hint: "Licences needed to run the asset.",
          supports: "operating_licence",
        },
        {
          key: "environmental_assessment",
          label: "Environmental impact assessment",
          hint: "Assessment and the conditions attached.",
          supports: "operating_licence",
        },
      ],
    },
    {
      key: "technical",
      label: "Technical",
      description: "Design, construction and operation of the asset.",
      categories: [
        {
          key: "technical_dd",
          label: "Independent technical due diligence",
          hint: "Engineer's report on design and condition.",
          supports: "technical_audit",
        },
        {
          key: "epc_contract",
          label: "Construction (EPC) contract",
          hint: "Contractor, price, schedule and guarantees.",
        },
        {
          key: "om_agreement",
          label: "Operations and maintenance agreement",
          hint: "Operator, scope and performance terms.",
        },
      ],
    },
    {
      key: "revenue",
      label: "Revenue contracts",
      description: "Tariffs, availability payments or offtake.",
      categories: [
        {
          key: "offtake",
          label: "Offtake, tariff or availability agreement",
          hint: "Who pays, how much and for how long.",
          supports: "offtake_agreement",
        },
      ],
    },
    IMPACT,
  ],
  other: [
    {
      key: "asset_ownership",
      label: "Ownership",
      description: "Evidence the issuer owns or controls the asset.",
      categories: [
        {
          key: "ownership_evidence",
          label: "Proof of asset ownership",
          hint: "Title, registration or purchase records.",
          supports: "asset_title",
        },
      ],
    },
    {
      key: "permits",
      label: "Licences and permits",
      description: "Permission to operate the asset.",
      categories: [
        {
          key: "licences",
          label: "Licences and permits",
          hint: "Any licence the activity requires.",
          supports: "operating_licence",
        },
      ],
    },
    {
      key: "technical",
      label: "Independent reports",
      description: "Expert opinion on the asset.",
      categories: [
        {
          key: "independent_report",
          label: "Independent expert report",
          hint: "Valuation, audit or engineering report.",
          supports: "technical_audit",
        },
      ],
    },
    {
      key: "revenue",
      label: "Revenue contracts",
      description: "Where the income comes from.",
      categories: [
        {
          key: "revenue_contracts",
          label: "Revenue contracts",
          hint: "Customer, offtake or rental agreements.",
          supports: "offtake_agreement",
        },
      ],
    },
  ],
};

/** Ordered sections for a project type: legal first, type-specific evidence, then common finance and reporting. */
export function documentSectionsFor(type: ProjectType): DocumentSection[] {
  return [CORPORATE, ...SPECIFIC[type], FINANCIAL, INSURANCE, REPORTING, OTHER];
}

/** Finds a category within a project type, or null when it does not belong to that type. */
export function findCategory(
  type: ProjectType,
  categoryKey: string,
): { section: DocumentSection; category: DocumentCategory } | null {
  for (const section of documentSectionsFor(type)) {
    const category = section.categories.find((c) => c.key === categoryKey);
    if (category) return { section, category };
  }
  return null;
}

export const CHECKLIST_LABEL: Record<ChecklistKey, string> = {
  legal_wrapper: "Legal wrapper",
  asset_title: "Asset title",
  operating_licence: "Operating licence",
  insurance: "Insurance",
  offtake_agreement: "Revenue contract",
  technical_audit: "Independent technical review",
  impact_methodology: "Impact methodology",
};
