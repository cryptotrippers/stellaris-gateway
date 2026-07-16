import { useState } from "react";
import { Check, Copy, Share2 } from "lucide-react";
import { trackEvent } from "@/lib/analytics";

interface ShareRowProps {
  url: string;
  text: string;
  eventName?: string;
  label?: string;
}

export function ShareRow({ url, text, eventName = "share_click", label = "Share" }: ShareRowProps) {
  const [copied, setCopied] = useState(false);

  const shareUrl = url.startsWith("http") ? url : (typeof window !== "undefined" ? window.location.origin + url : url);
  const xUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(shareUrl)}`;
  const redditUrl = `https://www.reddit.com/submit?url=${encodeURIComponent(shareUrl)}&title=${encodeURIComponent(text)}`;

  async function nativeShare() {
    trackEvent(eventName, { channel: "native" });
    if (typeof navigator !== "undefined" && "share" in navigator) {
      try {
        await navigator.share({ title: text, text, url: shareUrl });
        return;
      } catch { /* user cancelled */ }
    }
    copy();
  }

  async function copy() {
    trackEvent(eventName, { channel: "copy" });
    try {
      await navigator.clipboard.writeText(`${text} ${shareUrl}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch { /* ignore */ }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs uppercase tracking-widest text-muted-foreground mr-1">{label}</span>
      <button
        onClick={nativeShare}
        className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1.5 text-xs font-medium text-foreground hover:border-primary/50 hover:bg-secondary transition-colors"
      >
        <Share2 className="h-3.5 w-3.5" /> Share
      </button>
      <a
        href={xUrl}
        target="_blank"
        rel="noopener noreferrer"
        onClick={() => trackEvent(eventName, { channel: "x" })}
        className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1.5 text-xs font-medium text-foreground hover:border-primary/50 hover:bg-secondary transition-colors"
      >
        Post on X
      </a>
      <a
        href={redditUrl}
        target="_blank"
        rel="noopener noreferrer"
        onClick={() => trackEvent(eventName, { channel: "reddit" })}
        className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1.5 text-xs font-medium text-foreground hover:border-primary/50 hover:bg-secondary transition-colors"
      >
        Reddit
      </a>
      <button
        onClick={copy}
        className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1.5 text-xs font-medium text-foreground hover:border-primary/50 hover:bg-secondary transition-colors"
      >
        {copied ? <><Check className="h-3.5 w-3.5 text-success" /> Copied</> : <><Copy className="h-3.5 w-3.5" /> Copy link</>}
      </button>
    </div>
  );
}
