/**
 * Client-only chat surface. Rendered through a mounted guard + dynamic import
 * from `src/routes/ask.tsx` so SSR never paints it — the transcript and
 * composer are streaming UI and must be created by React on the client.
 */
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

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

const STARTERS = [
  "Who absorbs a loss first?",
  "How and when can I get my money out?",
  "What is actually live right now?",
  "What backs TSRA?",
];

function friendlyError(error: Error): string {
  const text = error.message || "";
  if (text.includes("credit") || text.includes("paused") || text.includes("busy")) return text;
  return "The assistant could not answer just now. Your question is still here — try again.";
}

export default function AssistantChat() {
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
    <div className="flex flex-col gap-6">
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
          <PromptInput onSubmit={({ text }) => send(text)} className="border-0 bg-transparent p-0">
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
    </div>
  );
}
