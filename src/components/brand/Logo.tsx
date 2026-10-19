/** Stellaris mark: a four-point star inside a rounded square, drawn from brand tokens. */
export function StellarisLogo({ className = "h-8 w-8" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <rect x="1" y="1" width="30" height="30" rx="9" fill="var(--stellaris-navy)" />
      <path
        d="M16 5.5 L18.4 13.6 L26.5 16 L18.4 18.4 L16 26.5 L13.6 18.4 L5.5 16 L13.6 13.6 Z"
        fill="var(--stellaris-white)"
      />
      <path d="M16 5.5 L18.4 13.6 L16 16 Z M26.5 16 L18.4 18.4 L16 16 Z" fill="var(--stellaris-aqua)" />
      <circle cx="16" cy="16" r="1.8" fill="var(--stellaris-gold)" />
    </svg>
  );
}

export function StellarisWordmark({ inverted = false }: { inverted?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <StellarisLogo className="h-7 w-7" />
      <div className="flex flex-col leading-none">
        <span
          className={`font-display text-[15px] font-bold tracking-tight ${inverted ? "text-deep-foreground" : "text-foreground"}`}
        >
          Stellaris
        </span>
        <span
          className={`text-[10px] font-medium uppercase tracking-[0.18em] ${inverted ? "text-deep-foreground/70" : "text-muted-foreground"}`}
        >
          Finance
        </span>
      </div>
    </div>
  );
}
