/**
 * Security Suite S1.6 — the confirmation step in front of the wallet.
 *
 * The sign guard (src/lib/tx-sign-guarded.ts) calls the handler registered here
 * just before it asks the wallet to sign, and only continues when the handler
 * resolves true. This dialog is that handler: it lists what the decoded
 * transaction will actually do and waits for the person to agree. Closing it
 * any other way — Cancel, Escape, or leaving the screen — is a cancel.
 *
 * Mounted once in src/routes/__root.tsx inside <ClientOnly>, so every page has
 * it and none of this runs during server rendering.
 */
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { setTxConfirmHandler } from "@/lib/tx-sign-guarded";
import { createTxConfirmQueue, type TxConfirmQueue } from "./tx-confirm-queue";

const noRequest = () => null;

/**
 * The dialog makes its own queue; a test can pass one in to drive it directly.
 */
export function TxConfirmDialog({ queue: providedQueue }: { queue?: TxConfirmQueue } = {}) {
  const queue = useMemo(() => providedQueue ?? createTxConfirmQueue(), [providedQueue]);
  const request = useSyncExternalStore(queue.subscribe, queue.snapshot, noRequest);
  const continueRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setTxConfirmHandler(queue.handle);
    return () => {
      setTxConfirmHandler(null);
      // A request still waiting when this goes away never reaches the wallet.
      queue.settle(false);
    };
  }, [queue]);

  return (
    <AlertDialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) queue.settle(false);
      }}
    >
      <AlertDialogContent
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          continueRef.current?.focus();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Check this transaction</AlertDialogTitle>
        </AlertDialogHeader>

        <ul
          role="list"
          aria-label="What this transaction will do"
          className="max-h-[45vh] space-y-1.5 overflow-y-auto rounded-md border border-border/60 bg-muted/40 p-3 font-mono text-xs leading-relaxed text-foreground"
        >
          {(request?.lines ?? []).map((line, index) => (
            <li key={`${index}:${line}`}>{line}</li>
          ))}
        </ul>

        <AlertDialogDescription>Your wallet will ask you to sign next.</AlertDialogDescription>

        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => queue.settle(false)}>Cancel</AlertDialogCancel>
          <AlertDialogAction ref={continueRef} onClick={() => queue.settle(true)}>
            Continue to wallet
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
