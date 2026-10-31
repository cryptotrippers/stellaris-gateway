/** Cancellation invalidates late extension/QR results even when providers cannot abort. */
export function createWalletAttemptGate() {
  let generation = 0;
  let pending = false;
  return {
    begin() { generation++; pending = true; return generation; },
    current(id: number) { return pending && id === generation; },
    finish(id: number) { if (id === generation) pending = false; },
    cancel() { generation++; pending = false; },
    get pending() { return pending; },
  };
}