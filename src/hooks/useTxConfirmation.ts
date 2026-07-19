import { useQuery } from "@tanstack/react-query";
import { getTxConfirmation } from "@/lib/blockfrost.functions";

export type TxConfirmationState = "pending" | "confirmed" | "not_found" | "error";

export interface TxConfirmationInfo {
  state: TxConfirmationState;
  confirmations: number;
  block: number | null;
  blockTime: number | null;
  detail?: string;
}

/**
 * Polls Blockfrost until the given tx hash appears on-chain, then keeps
 * refreshing the confirmation depth every 30s.
 */
export function useTxConfirmation(txHash: string | null | undefined) {
  return useQuery<TxConfirmationInfo>({
    enabled: Boolean(txHash),
    queryKey: ["tx-confirmation", txHash],
    queryFn: async () => {
      const res = await getTxConfirmation({ data: { txHash: txHash as string } });
      return res;
    },
    refetchInterval: (q) => {
      const s = q.state.data?.state;
      if (s === "confirmed") return 30_000;
      return 8_000;
    },
    staleTime: 5_000,
  });
}
