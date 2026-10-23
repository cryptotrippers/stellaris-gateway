/**
 * Tessera preprod-v1 — the LIVE Preprod deployment (public, read-only facts).
 *
 * Source: deployments/preprod-v1.json, produced by scripts/tessera/* and
 * confirmed on Cardano Preprod 2026-10-21..23. Every value here is public
 * on-chain data (script hashes, addresses, token units, tx hashes); nothing
 * secret. If the reserve is ever redeployed (new label), this file changes.
 *
 * PROVISIONAL: the reserve/vault/queue datums are provisional until counsel
 * answers (contracts/tessera/SPEC.md §1); preprod-v1 is a throwaway test
 * deployment, not real money.
 */
export const TESSERA_PREPROD = {
  label: "preprod-v1",
  network: "Preprod" as const,
  explorer: "https://preprod.cardanoscan.io",
  decimals: 6,
  reserve: {
    scriptHash: "938b32e0f660dc06d3b58a20103cbe5ae1cc00531b53c7ba191d7400",
    address: "addr_test1wzfckvhq7esdcpknkk9zqypuhedwrnqq2vd483a6rywhgqq9q5crd",
    tsraUnit: "938b32e0f660dc06d3b58a20103cbe5ae1cc00531b53c7ba191d740054535241",
    configUnit: "938b32e0f660dc06d3b58a20103cbe5ae1cc00531b53c7ba191d7400636f6e666967",
    supplyUnit: "938b32e0f660dc06d3b58a20103cbe5ae1cc00531b53c7ba191d7400737570706c79",
    genesisTx: "f0ebcf81548b2a9a0778e782a6f623951be361c90122d7ca01e61352fb4cff59",
  },
  vault: {
    scriptHash: "b52a0afbc9be3fd2e587bbe7925caaaaebac982d392e8bbbe58454ac",
    address: "addr_test1wz6j5zhmexlrl5h9s7a70yju424whtyc95ujazamukz9ftqwujfnm",
    stateUnit: "b52a0afbc9be3fd2e587bbe7925caaaaebac982d392e8bbbe58454ac7374617465",
    stsraUnit: "b52a0afbc9be3fd2e587bbe7925caaaaebac982d392e8bbbe58454ac7354535241",
    markerUnit: "b52a0afbc9be3fd2e587bbe7925caaaaebac982d392e8bbbe58454ac706f736974696f6e",
    genesisTx: "336f51b22f099a9ce7c5f220424d5c8b714f6984e42e4e041c980a1570902f55",
  },
  firstLoss: {
    scriptHash: "ccfb81fa54e33ebc3b3239a1a1f15ea11eb175005f66cba9ab028fbe",
    address: "addr_test1wrx0hq062n3na0pmxgu6rg03t6s3avt4qp0kdjaf4vpgl0st4fq8g",
    stateUnit: "ccfb81fa54e33ebc3b3239a1a1f15ea11eb175005f66cba9ab028fbe7374617465",
  },
  queue: {
    scriptHash: "64021fe6d4fbc2fb828e593311c238ea76401598fba83160c9930860",
    address: "addr_test1wpjqy8lx6nau97uz3evnxywz8r48vsq4nra6svtqexfsscq0m2ptg",
    configUnit: "64021fe6d4fbc2fb828e593311c238ea76401598fba83160c99308607175657565",
    shortUnit: "64021fe6d4fbc2fb828e593311c238ea76401598fba83160c993086073686f7274",
    requestUnit: "64021fe6d4fbc2fb828e593311c238ea76401598fba83160c993086072657175657374",
    shardUnits: [
      "64021fe6d4fbc2fb828e593311c238ea76401598fba83160c9930860736861726400",
      "64021fe6d4fbc2fb828e593311c238ea76401598fba83160c9930860736861726401",
      "64021fe6d4fbc2fb828e593311c238ea76401598fba83160c9930860736861726402",
      "64021fe6d4fbc2fb828e593311c238ea76401598fba83160c9930860736861726403",
    ],
    genesisTx: "ca55e1296c48da13b5dfe00db5428f5097830c4aeee974f3778d88913d425bb7",
  },
  /** Preprod test payout token for the queue (not a real stablecoin). */
  tusd: {
    policyId: "e13ff0eeb0dc21dd67ea0e6a7e10343936d519201e7b65d035fc045a",
    unit: "e13ff0eeb0dc21dd67ea0e6a7e10343936d519201e7b65d035fc045a74555344",
    ticker: "tUSD",
  },
  /** Test operator wallet (also the Preprod treasury). */
  operatorAddress: "addr_test1vpf6yc96tace29j6nj504pvj8z0rm2vvyhjaff0md8s5lrsv0c0f5",
  registryPrs: {
    tsra: "https://github.com/cardano-foundation/metadata-registry-testnet/pull/2995",
    stsra: "https://github.com/cardano-foundation/metadata-registry-testnet/pull/2996",
  },
} as const;

/** 1e-6 units (bigint string) → whole-token number for display only. */
export function units6(x: string | bigint): number {
  return Number(BigInt(x)) / 1e6;
}

export const txUrl = (hash: string) => `${TESSERA_PREPROD.explorer}/transaction/${hash}`;
export const addressUrl = (addr: string) => `${TESSERA_PREPROD.explorer}/address/${addr}`;
