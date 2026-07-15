export function StellarisLogo({ className = "h-8 w-8" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <defs>
        <linearGradient id="sg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="oklch(0.36 0.19 264)" />
          <stop offset="100%" stopColor="oklch(0.72 0.13 200)" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="30" height="30" rx="8" fill="url(#sg)" />
      <path d="M16 6 L18.6 13.4 L26 16 L18.6 18.6 L16 26 L13.4 18.6 L6 16 L13.4 13.4 Z" fill="white" opacity="0.95" />
      <circle cx="16" cy="16" r="2.2" fill="oklch(0.36 0.19 264)" />
    </svg>
  );
}

export function StellarisWordmark() {
  return (
    <div className="flex items-center gap-2">
      <StellarisLogo className="h-7 w-7" />
      <div className="flex flex-col leading-none">
        <span className="text-[15px] font-semibold tracking-tight text-foreground">Stellaris</span>
        <span className="text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">Finance</span>
      </div>
    </div>
  );
}
