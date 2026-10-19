import energyImg from "@/assets/home-energy.jpg";
import propertyImg from "@/assets/home-property.jpg";
import agricultureImg from "@/assets/home-agriculture.jpg";

/** Illustrative category photography — never a photo of the actual asset. */
export function categoryImage(category: string): string {
  const c = category.toLowerCase();
  if (c.includes("energy") || c.includes("solar") || c.includes("infra")) return energyImg;
  if (c.includes("estate") || c.includes("property") || c.includes("housing")) return propertyImg;
  return agricultureImg;
}

/** One-line risk label shown on every card and detail header. */
export function riskLabel(status: string): string {
  if (status === "demo") return "Demo — not investable";
  if (status === "pilot" || status === "draft") return "Preprod test asset · unaudited contract";
  return "Testnet only · unaudited contract";
}

export const STATUS_TONE: Record<string, "primary" | "accent" | "warning" | "success"> = {
  demo: "warning",
  pilot: "warning",
  draft: "warning",
  open: "accent",
  funded: "success",
  closed: "primary",
};
