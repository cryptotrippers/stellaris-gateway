/**
 * Security Suite S1.6 — the queue behind the transaction confirmation dialog.
 *
 * The sign guard (src/lib/tx-sign-guarded.ts) hands this module one request at
 * a time and waits for the answer. It is plain TypeScript with no React and no
 * browser APIs so the rules it has to keep — one open request, a second request
 * cancels the first, an unanswered dialog is a cancel — can be tested directly.
 */

export interface TxConfirmRequest {
  /** The action the transaction builder declared, e.g. "deposit". */
  readonly action: string;
  /** One plain-text line per fact the guard decoded from the transaction. */
  readonly lines: readonly string[];
}

export interface TxConfirmQueue {
  /**
   * Called by the sign guard just before the wallet is asked to sign. Stays
   * pending until settle() answers it; resolves false when cancelled.
   */
  handle(action: string, lines: readonly string[]): Promise<boolean>;
  /** Answer the open request. A second call does nothing. */
  settle(accepted: boolean): void;
  /** The open request, or null. The reference is stable until it changes. */
  snapshot(): TxConfirmRequest | null;
  /** Watch for a request opening or closing. Returns the unsubscribe call. */
  subscribe(listener: () => void): () => void;
}

export function createTxConfirmQueue(): TxConfirmQueue {
  let current: TxConfirmRequest | null = null;
  let pending: ((accepted: boolean) => void) | null = null;
  const listeners = new Set<() => void>();

  function notify() {
    for (const listener of [...listeners]) listener();
  }

  function settle(accepted: boolean) {
    const answer = pending;
    if (!answer) return;
    pending = null;
    current = null;
    notify();
    answer(accepted);
  }

  return {
    handle(action, lines) {
      // Only one request is ever open: a new one cancels the previous.
      settle(false);
      const request: TxConfirmRequest = { action, lines: [...lines] };
      return new Promise<boolean>((resolve) => {
        pending = resolve;
        current = request;
        notify();
      });
    },
    settle,
    snapshot: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
