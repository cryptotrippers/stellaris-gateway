/** Retry only the chain-indexing delay; never retry rejected registration writes. */
export async function retryPendingConfirmation<T>(
  register: () => Promise<T>,
  onPending: () => void,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await register();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("NOT_CONFIRMED")) throw error;
      if (attempt >= 30) {
        throw new Error(
          "Transaction submitted, but confirmation is still pending. Keep the seed details and retry registration; do not bootstrap again.",
        );
      }
      onPending();
      await wait(10_000);
    }
  }
}
