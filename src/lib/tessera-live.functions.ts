import { createServerFn } from "@tanstack/react-start";
import type { TesseraLive } from "./tessera-live.shared";

/**
 * Live snapshot of the Tessera preprod-v1 deployment (reserve, sTSRA vault,
 * first-loss, redemption queue), read from Blockfrost on the server and
 * decoded from the on-chain datums. Public, read-only data.
 */
export const getTesseraLive = createServerFn({ method: "GET" }).handler(
  async (): Promise<TesseraLive> => {
    const { fetchTesseraLive } = await import("./tessera-live.server");
    return fetchTesseraLive();
  },
);
