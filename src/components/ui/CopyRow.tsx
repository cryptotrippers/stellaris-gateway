import { useState } from "react";
import { Check, Copy } from "lucide-react";

/** A labelled monospace value with a copy-to-clipboard button. */
export function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable — the value is still selectable
    }
  };
  return (
    <div>
      <div className="text-muted-foreground">{label}</div>
      <div className="mt-0.5 flex items-start gap-2">
        <span className="break-all font-mono text-foreground">{value}</span>
        <button
          type="button"
          onClick={copy}
          aria-label={`Copy ${label}`}
          className="shrink-0 rounded border border-border p-1 text-muted-foreground hover:text-foreground"
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
        </button>
      </div>
    </div>
  );
}
