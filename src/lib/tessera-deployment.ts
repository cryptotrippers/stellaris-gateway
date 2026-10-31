/**
 * What the Tessera browser builders (`tessera-tx.ts`) need to know about one
 * deployment: script hashes, addresses, thread-token units, the reward
 * addresses of the withdraw-zero scripts, the on-chain reference scripts, and
 * the applied `redeem_queue` script (it has no reference script).
 *
 * Public on-chain facts only. `TESSERA_PREPROD_V1_DEPLOYMENT` is checked
 * against deployments/preprod-v1.json in tests/contracts/tessera-browser.test.ts.
 * preprod-v2 (after the counsel rebuild) gets its own constant; nothing else
 * in the builders changes.
 */
import { TESSERA_PREPROD } from "./tessera-preprod";
import { TESSERA_QUEUE_SCRIPT_PREPROD_V1 } from "./tessera-queue-script.generated";

export interface OutRef {
  txHash: string;
  outputIndex: number;
}

export interface TesseraDeployment {
  label: string;
  /** Lucid network name. */
  network: "Preprod" | "Custom";
  reserve: { hash: string; address: string; tsraUnit: string; configUnit: string };
  vault: {
    hash: string;
    address: string;
    stateUnit: string;
    stsraUnit: string;
    markerUnit: string;
  };
  /** vault_ops withdraw-zero script (Claim's State side). */
  ops: { hash: string; rewardAddress: string };
  queue: {
    hash: string;
    address: string;
    configUnit: string;
    shortUnit: string;
    requestUnit: string;
    shardUnits: readonly string[];
    /** Applied redeem_queue (spend + marker policy), checked against `hash` before use. */
    script: string;
  };
  /** queue_flow withdraw-zero script (Request, Instant, Settle). */
  flow: { hash: string; rewardAddress: string };
  /** Reference-script UTxOs, each checked against its expected hash before use. */
  refs: { vault: OutRef; ops: OutRef; flow: OutRef };
  /** Payout token of the queue (tUSD on Preprod). */
  payoutUnit: string;
  features: {
    /**
     * An owner's plain Cancel of an unregistered Request. False on preprod-v1:
     * the marker burn needs a queue script that no action provides (security
     * review 23 Oct, C-1); fixed in the counsel rebuild (preprod-v2).
     */
    cancel: boolean;
  };
}

const ref = (s: string): OutRef => {
  const [txHash, ix] = s.split("#");
  return { txHash: txHash!, outputIndex: Number(ix) };
};

export const TESSERA_PREPROD_V1_DEPLOYMENT: TesseraDeployment = {
  label: TESSERA_PREPROD.label,
  network: "Preprod",
  reserve: {
    hash: TESSERA_PREPROD.reserve.scriptHash,
    address: TESSERA_PREPROD.reserve.address,
    tsraUnit: TESSERA_PREPROD.reserve.tsraUnit,
    configUnit: TESSERA_PREPROD.reserve.configUnit,
  },
  vault: {
    hash: TESSERA_PREPROD.vault.scriptHash,
    address: TESSERA_PREPROD.vault.address,
    stateUnit: TESSERA_PREPROD.vault.stateUnit,
    stsraUnit: TESSERA_PREPROD.vault.stsraUnit,
    markerUnit: TESSERA_PREPROD.vault.markerUnit,
  },
  ops: {
    hash: "32e3297312809c82cce6df5eabe55a4e9ea4b4e19e549df0c3a2972f",
    rewardAddress: "stake_test17qewx2tnz2qfeqkvum04a2l9tf8faf95ux09f80scw3fwtcelz6s9",
  },
  queue: {
    hash: TESSERA_PREPROD.queue.scriptHash,
    address: TESSERA_PREPROD.queue.address,
    configUnit: TESSERA_PREPROD.queue.configUnit,
    shortUnit: TESSERA_PREPROD.queue.shortUnit,
    requestUnit: TESSERA_PREPROD.queue.requestUnit,
    shardUnits: TESSERA_PREPROD.queue.shardUnits,
    script: TESSERA_QUEUE_SCRIPT_PREPROD_V1,
  },
  flow: {
    hash: "bf2e6f6f7fdc2f567a67133494140e57ced77e4501142dab1def085a",
    rewardAddress: "stake_test17zljumm00lwz74n6vufnf9q5petua4m7g5q3gtdtrhhssksrjhkld",
  },
  refs: {
    vault: ref("a83ef041b8f2a9650ec48921b698a89c2224c183b91d3934bf89717a622617c0#0"),
    ops: ref("31190d572179db77765ea835347013aaa851f294eef19c302f3ffca35969c6e1#0"),
    flow: ref("7b8744fa1f57bb454c2cb95dc83387427a66152e2d325560f48225c957f4a0c8#0"),
  },
  payoutUnit: TESSERA_PREPROD.tusd.unit,
  features: { cancel: false },
};
