import energyImg from "@/assets/home-energy.jpg";
import propertyImg from "@/assets/home-property.jpg";
import agricultureImg from "@/assets/home-agriculture.jpg";
import commercialImg from "@/assets/category-commercial.jpg";
import infrastructureImg from "@/assets/category-infrastructure.jpg";
import testVaultImg from "@/assets/category-testvault.jpg";

/** Featured asset classes. Concept categories — not approved listings. */
export type CategoryGroup =
  | "energy"
  | "residential"
  | "commercial"
  | "agriculture"
  | "infrastructure"
  | "other";

export const CATEGORY_GROUPS: {
  key: Exclude<CategoryGroup, "other">;
  label: string;
  blurb: string;
  image: string;
}[] = [
  {
    key: "energy",
    label: "Solar and Renewable Energy",
    blurb: "Rooftop and utility solar, storage and other generation assets with metered output.",
    image: energyImg,
  },
  {
    key: "residential",
    label: "Residential Property",
    blurb: "Housing where rent, not speculation, is the source of income.",
    image: propertyImg,
  },
  {
    key: "commercial",
    label: "Commercial Property",
    blurb: "Offices, retail and logistics space let to operating businesses.",
    image: commercialImg,
  },
  {
    key: "agriculture",
    label: "Agriculture",
    blurb: "Farms, aquaculture and food production with seasonal revenue.",
    image: agricultureImg,
  },
  {
    key: "infrastructure",
    label: "Infrastructure",
    blurb: "Water, transport and grid assets with long-term service contracts.",
    image: infrastructureImg,
  },
];

/** Maps a stored free-text category onto one of the featured groups. */
export function categoryGroup(category: string): CategoryGroup {
  const c = category.toLowerCase();
  if (c.includes("commercial") || c.includes("office") || c.includes("retail")) return "commercial";
  if (c.includes("infra") || c.includes("water") || c.includes("transport")) return "infrastructure";
  if (c.includes("energy") || c.includes("solar") || c.includes("renewable") || c.includes("wind"))
    return "energy";
  if (
    c.includes("estate") ||
    c.includes("property") ||
    c.includes("housing") ||
    c.includes("residential")
  )
    return "residential";
  if (c.includes("farm") || c.includes("agri") || c.includes("aqua") || c.includes("food"))
    return "agriculture";
  return "other";
}

export function groupLabel(group: CategoryGroup): string {
  return CATEGORY_GROUPS.find((g) => g.key === group)?.label ?? "Preprod test vault";
}

/** Illustrative category photography — never a photo of the actual asset. */
export function categoryImage(category: string): string {
  const g = categoryGroup(category);
  return CATEGORY_GROUPS.find((x) => x.key === g)?.image ?? testVaultImg;
}

/** One-line risk label shown on every card and detail header. */
export function riskLabel(status: string): string {
  if (status === "demo") return "Demo — not investable";
  if (status === "pilot" || status === "draft") return "Preprod test asset · unaudited contract";
  return "Testnet only · unaudited contract";
}

export const STATUS_LABEL: Record<string, string> = {
  demo: "Demo",
  pilot: "Preprod pilot",
  draft: "Draft",
  open: "Open on testnet",
  funded: "Funded",
  closed: "Closed",
};

export function statusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status;
}

export const STATUS_TONE: Record<string, "primary" | "accent" | "warning" | "success"> = {
  demo: "warning",
  pilot: "warning",
  draft: "warning",
  open: "accent",
  funded: "success",
  closed: "primary",
};
