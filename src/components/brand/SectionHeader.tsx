export function SectionHeader({
  eyebrow,
  title,
  description,
  align = "left",
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  align?: "left" | "center";
}) {
  return (
    <div className={`max-w-2xl ${align === "center" ? "mx-auto text-center" : ""}`}>
      {eyebrow && <p className="home-eyebrow">{eyebrow}</p>}
      <h2 className="mt-3 font-display text-3xl font-semibold leading-tight md:text-4xl">{title}</h2>
      {description && (
        <p className="mt-4 text-sm leading-relaxed text-muted-foreground md:text-base">{description}</p>
      )}
    </div>
  );
}
