import { createFileRoute, Link } from "@tanstack/react-router";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { MarketingNav } from "@/components/layout/MarketingNav";
import { MarketingFooter } from "@/components/layout/MarketingFooter";
import { StellarisLogo } from "@/components/brand/Logo";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import {
  PromptInput,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
} from "@/components/ai-elements/prompt-input";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/ask")({
  head: () => ({
    meta: [
      { title: "Ask Stellaris · Questions about reserves, staking and exit rules" },
      {
        name: "description",
        content:
          "Ask a plain-English question about how Stellaris works: the reserve model, staking cooldowns, who absorbs a loss first, and what is still pending. Preprod testnet preview.",
      },
      { property: "og:title", content: "Ask Stellaris" },
      {
        property: "og:description",
        content:
          "A helper that answers only from what this site already publishes — reserves, staking rules, protections and what is still pending.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: AskPage,
});

const STARTERS = [
  "Who absorbs a loss first?",
  "How and when can I get my money out?",
  "What is actually live right now?",
  "What backs TSRA?",
];

function friendlyError(error: Error): string {
  const text = error.message || "";
  if (text.includes("credit") || text.includes("paused")) return text;
  if (text.includes("busy")) return text;
  return "The assistant could not answer just now. Your question is still here — try again.";
}

function AskPage() {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const { messages, status, sendMessage, setMessages, stop, clearError, error } = useChat({
    transport: new DefaultChatTransport({ api: "/api/chat" }),
    onError: (err) => setNotice(friendlyError(err)),
  });

  const busy = status === "submitted" || status === "streaming";

  // Keep the composer ready to type: on load, after sending, and when a reply ends.
  useEffect(() => {
    if (busy) return;
    const area = surfaceRef.current?.querySelector("textarea");
    area?.focus();
  }, [busy, messages.length]);

  useEffect(() => {
    if (!error) return;
    toast.error(friendlyError(error));
    clearError();
  }, [error, clearError]);

  const send = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setNotice(null);
    void sendMessage({ text: trimmed });
  };

  return (
    <div className="home-page flex min-h-screen flex-col bg-background text-foreground">
      <MarketingNav />
      <main className="home-container flex flex-1 flex-col gap-6 py-12">
        <header className="max-w-2xl">
          <p className="home-eyebrow">Ask Stellaris</p>
          <h1 className="mt-3 font-display text-3xl font-semibold leading-tight md:text-4xl">
            Ask anything about how this works
          </h1>
          <p className="mt-4 text-sm leading-relaxed text-muted-foreground md:text-base">
            The helper answers only from what this site already publishes — the reserve model,
            staking rules, who absorbs a loss first, and what is still pending. If something
            isn&apos;t published yet, it says so rather than guessing. Not financial advice.
          </p>
        </header>

        <div
          ref={surfaceRef}
          className="home-card flex h-[62vh] min-h-[420px] flex-col overflow-hidden p-0"
        >
          <Conversation>
            <ConversationContent className="gap-6 p-4 md:p-6">
              {messages.length === 0 && (
                <ConversationEmptyState
                  icon={<StellarisLogo className="h-10 w-10" />}
                  title="No questions yet"
                  description="Ask in plain English, or start with one of these."
                />
              )}

              {messages.map((message) => {
                const isUser = message.role === "user";
                const reasoning = message.parts
                  .filter((p) => p.type === "reasoning")
                  .map((p) => ("text" in p ? p.text : ""))
                  .join(" ")
                  .trim();
                const answer = message.parts
                  .filter((p) => p.type === "text")
                  .map((p) => ("text" in p ? p.text : ""))
                  .join("");

                return (
                  <Message key={message.id} from={message.role}>
                    <MessageContent>
                      {!isUser && reasoning && (
                        <details className="mb-2 rounded-md border border-border bg-secondary/40 px-3 py-2 text-xs text-muted-foreground">
                          <summary className="cursor-pointer select-none">
                            How it worked that out
                          </summary>
                          <p className="mt-2 whitespace-pre-wrap leading-relaxed">{reasoning}</p>
                        </details>
                      )}
                      {isUser ? (
                        <span className="whitespace-pre-wrap">{answer}</span>
                      ) : (
                        <MessageResponse>{answer}</MessageResponse>
                      )}
                    </MessageContent>
                  </Message>
                );
              })}

              {status === "submitted" && (
                <Message from="assistant">
                  <MessageContent>
                    <Shimmer>Thinking…</Shimmer>
                  </MessageContent>
                </Message>
              )}
            </ConversationContent>
            <ConversationScrollButton />
          </Conversation>

          <div className="border-t border-border bg-surface/60 p-3 md:p-4">
            {notice && (
              <p role="alert" className="mb-2 text-xs text-destructive">
                {notice}
              </p>
            )}
            <PromptInput
              onSubmit={({ text }) => send(text)}
              className="border-0 bg-transparent p-0"
            >
              <PromptInputTextarea
                placeholder="e.g. What happens to my money if an originator defaults?"
                disabled={busy}
              />
              <PromptInputFooter className="justify-end">
                <PromptInputSubmit status={status} onStop={stop} />
              </PromptInputFooter>
            </PromptInput>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {messages.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setMessages([]);
                setNotice(null);
              }}
            >
              Start a new question
            </Button>
          )}
          {STARTERS.map((s) => (
            <Button
              key={s}
              variant="ghost"
              size="sm"
              className="border border-border text-muted-foreground"
              disabled={busy}
              onClick={() => send(s)}
            >
              {s}
            </Button>
          ))}
        </div>

        <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground">
          This is a testnet preview. Nothing here is financial, legal or tax advice, and no
          real-money offering is available. Rates shown on this site are illustrative targets, not
          promises. For the full picture see{" "}
          <Link to="/terms" className="text-primary underline-offset-4 hover:underline">
            terms &amp; risk
          </Link>
          .
        </p>
      </main>
      <MarketingFooter />
    </div>
  );
}
