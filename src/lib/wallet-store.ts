import { useSyncExternalStore } from "react";
import {
  enableWallet,
  signDataWithWallet,
  classifyCIP30Error,
  hasExtension,
  isWalletEnabled,
  refreshEnabledWallet,
  forgetWalletApis,
  type CardanoWalletId,
  type CIP30Error,
} from "./cip30";
import type { Cip34Chain, PairingHandle } from "./walletconnect";
import { withTimeout } from "./auth-flow.shared";
import { createWalletAttemptGate } from "./wallet-attempt.shared";
import { confirmReferral } from "./referral";
import { EXPECTED_WALLET_NETWORK_ID } from "./network";
import { checkWalletNetworkAtConnect } from "./wallet-network-gate";

export type WalletProvider =
  | "Lace"
  | "Eternl"
  | "Nami"
  | "Typhon"
  | "Flint"
  | "Yoroi"
  | "GeroWallet"
  | "Vespr"
  | "WalletConnect";

export type WalletConnectResult = { ok: true; mock?: false } | { ok: false; error: CIP30Error };

export interface WalletState {
  connecting: boolean;
  connectionError: string | null;
  connected: boolean;
  provider: WalletProvider | null;
  /** Bech32 address if we've resolved it (from CIP-30 hex → bech32 via Blockfrost or wallet call), otherwise the raw hex. */
  address: string | null;
  addressHex: string | null;
  balanceAda: number;
  networkId: 0 | 1 | null; // 0 = testnet
  /** WalletConnect session topic (only set when provider === "WalletConnect"). */
  wcTopic?: string | null;
  /** Read-only "view by address" mode — independent of `connected`. */
  viewerAddress: string | null;
  viewerKind: "payment" | "stake" | null;
  viewerNetworkId: 0 | 1 | null;
}

const STORAGE_KEY = "stellaris:wallet:last-provider";
const VIEWER_STORAGE_KEY = "stellaris:wallet:viewer-address";

let state: WalletState = {
  connecting: false,
  connectionError: null,
  connected: false,
  provider: null,
  address: null,
  addressHex: null,
  balanceAda: 0,
  networkId: null,
  wcTopic: null,
  viewerAddress: null,
  viewerKind: null,
  viewerNetworkId: null,
};

const listeners = new Set<() => void>();
const attempts = createWalletAttemptGate();
let restorePromise: Promise<void> | null = null;
let refreshing = false;
const serverState = state;
function emit() {
  listeners.forEach((l) => l());
}

const ID_MAP: Record<Exclude<WalletProvider, "WalletConnect">, CardanoWalletId> = {
  Lace: "lace",
  Eternl: "eternl",
  Nami: "nami",
  Typhon: "typhon",
  Flint: "flint",
  Yoroi: "yoroi",
  GeroWallet: "gerowallet",
  Vespr: "vespr",
};

function persist(provider: WalletProvider | null) {
  if (typeof window === "undefined") return;
  try {
    if (provider && provider !== "WalletConnect")
      window.localStorage.setItem(STORAGE_KEY, provider);
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore quota / private-mode */
  }
}

/**
 * Connect to a browser wallet via CIP-30. Returns a typed error on failure —
 * no silent mock fallback.
 */
export async function connectWallet(
  provider: Exclude<WalletProvider, "WalletConnect">,
): Promise<WalletConnectResult> {
  if (attempts.pending)
    return {
      ok: false,
      error: { kind: "unknown", message: "Another wallet connection is pending. Cancel it first." },
    };
  const attempt = attempts.begin();
  state = { ...state, connecting: true, connectionError: null };
  emit();
  const id = ID_MAP[provider];
  if (!id) {
    attempts.finish(attempt);
    state = { ...state, connecting: false, connectionError: "Unsupported wallet provider." };
    emit();
    return { ok: false, error: { kind: "unknown", message: "Unsupported wallet provider." } };
  }
  const installed = hasExtension(id);
  if (!installed) {
    attempts.finish(attempt);
    state = {
      ...state,
      connecting: false,
      connectionError: `${provider} extension not detected. Install it and reload the page.`,
    };
    emit();
    return {
      ok: false,
      error: {
        kind: "no_extension",
        message: `${provider} extension not detected. Install it and reload the page.`,
      },
    };
  }
  try {
    const info = await withTimeout(enableWallet(id), 30_000);
    if (!attempts.current(attempt))
      return { ok: false, error: { kind: "rejected", message: "Connection cancelled." } };
    // E21: a wallet on the wrong network (above all mainnet) never connects.
    const refusal = checkWalletNetworkAtConnect(info.networkId, EXPECTED_WALLET_NETWORK_ID);
    if (refusal) {
      persist(null);
      state = { ...state, connectionError: refusal.message };
      return { ok: false, error: refusal };
    }
    state = {
      ...state,
      connected: true,
      connectionError: null,
      provider,
      address: info.changeAddressHex,
      addressHex: info.changeAddressHex,
      balanceAda: info.balanceAda,
      networkId: info.networkId,
      wcTopic: null,
    };
    persist(provider);
    emit();
    confirmReferral("wallet_connect");
    return { ok: true };
  } catch (e) {
    const error = classifyCIP30Error(e, installed);
    if (attempts.current(attempt)) state = { ...state, connectionError: error.message };
    return { ok: false, error };
  } finally {
    if (attempts.current(attempt)) {
      attempts.finish(attempt);
      state = { ...state, connecting: false };
      emit();
    }
  }
}

/**
 * Try to silently restore the last connected browser wallet (called on app boot).
 * Only re-enables if the extension still reports an active session — never prompts.
 */
async function restoreOnce(): Promise<void> {
  if (typeof window === "undefined") return;
  restoreViewer();
  if (state.connected || attempts.pending) return;
  const attempt = attempts.begin();
  try {
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(STORAGE_KEY);
    } catch {
      return;
    }
    if (!stored) return;
    const provider = stored as Exclude<WalletProvider, "WalletConnect">;
    const id = ID_MAP[provider];
    if (!id) return;
    if (!hasExtension(id)) return;
    const enabled = await withTimeout(isWalletEnabled(id), 8000);
    if (!enabled) return;
    try {
      const info = await withTimeout(enableWallet(id), 10_000);
      if (!attempts.current(attempt)) return;
      // E21: never silently restore a wallet that has moved to another network.
      if (checkWalletNetworkAtConnect(info.networkId, EXPECTED_WALLET_NETWORK_ID)) {
        persist(null);
        return;
      }
      state = {
        ...state,
        connected: true,
        provider,
        address: info.changeAddressHex,
        addressHex: info.changeAddressHex,
        balanceAda: info.balanceAda,
        networkId: info.networkId,
        wcTopic: null,
      };
      emit();
    } catch {
      persist(null);
    }
  } catch {
    persist(null);
  } finally {
    attempts.finish(attempt);
  }
}

export function restoreWallet(): Promise<void> {
  if (!restorePromise)
    restorePromise = restoreOnce().finally(() => {
      restorePromise = null;
    });
  return restorePromise;
}

/**
 * Begin a CIP-45 WalletConnect pairing. Returns the pairing URI (encode
 * as QR) and a promise that resolves once the mobile wallet approves.
 */
export async function connectWithWalletConnect(
  chain: Cip34Chain = "preprod",
): Promise<PairingHandle> {
  if (chain !== "preprod") throw new Error("Stellaris connects only to Preprod.");
  if (attempts.pending) throw new Error("Another wallet connection is pending. Cancel it first.");
  const attempt = attempts.begin();
  state = { ...state, connecting: true, connectionError: null };
  emit();
  let started: PairingHandle;
  try {
    const { startPairing } = await import("./walletconnect");
    started = await withTimeout(startPairing(chain), 20_000);
  } catch (error) {
    if (attempts.current(attempt)) {
      attempts.finish(attempt);
      state = {
        ...state,
        connecting: false,
        connectionError: error instanceof Error ? error.message : "Pairing failed.",
      };
      emit();
    }
    throw error;
  }
  if (!attempts.current(attempt)) {
    void started.cancel();
    throw new Error("Connection cancelled.");
  }
  // E21: a mobile wallet that approves on the wrong network is disconnected
  // and the caller's `approval` rejects with the refusal message.
  const approval = withTimeout(started.approval, 90_000).then(async (acct) => {
    const { disconnectSession } = await import("./walletconnect");
    if (!attempts.current(attempt)) {
      await disconnectSession(acct.topic);
      throw new Error("Connection cancelled.");
    }
    const refusal = checkWalletNetworkAtConnect(acct.networkId, EXPECTED_WALLET_NETWORK_ID);
    if (refusal || acct.chainId !== "cip34:0-1") {
      try {
        await disconnectSession(acct.topic);
      } catch {
        /* best effort — the session is never promoted either way */
      }
      throw new Error(
        refusal?.message ?? "The mobile wallet must approve the Preprod chain, not Preview.",
      );
    }
    return acct;
  });
  const handle: PairingHandle = {
    ...started,
    approval,
    cancel: async () => {
      cancelWalletConnection();
      await started.cancel();
    },
  };
  // Fire-and-forget: when approval lands, promote it into wallet state.
  handle.approval
    .then((acct) => {
      if (!attempts.current(attempt)) return;
      if (checkWalletNetworkAtConnect(acct.networkId, EXPECTED_WALLET_NETWORK_ID)) return;
      state = {
        ...state,
        connected: true,
        connecting: false,
        connectionError: null,
        provider: "WalletConnect",
        address: acct.stakeAddress,
        addressHex: null,
        balanceAda: 0, // balance requires a follow-up cardano_getBalance RPC
        networkId: acct.networkId,
        wcTopic: acct.topic,
      };
      attempts.finish(attempt);
      emit();
      confirmReferral("wallet_connect");
    })
    .catch((error) => {
      if (attempts.current(attempt)) {
        attempts.finish(attempt);
        state = {
          ...state,
          connecting: false,
          connectionError: error instanceof Error ? error.message : "Pairing failed.",
        };
        emit();
      }
    });
  // A cancelled/timed-out approval can still arrive from the provider: close it, never promote it.
  void started.approval
    .then((acct) => {
      if (!attempts.current(attempt) && state.wcTopic !== acct.topic)
        void import("./walletconnect").then((m) => m.disconnectSession(acct.topic)).catch(() => {});
    })
    .catch(() => {});
  return handle;
}

export function isWalletConnectConfigured() {
  return Boolean(import.meta.env.VITE_WALLETCONNECT_PROJECT_ID);
}

export function cancelWalletConnection() {
  attempts.cancel();
  state = { ...state, connecting: false };
  emit();
}

/** One root monitor reads enabled extension APIs; changes invalidate the signer. */
export async function refreshWalletConnection() {
  if (
    refreshing ||
    attempts.pending ||
    !state.connected ||
    !state.provider ||
    state.provider === "WalletConnect"
  )
    return;
  refreshing = true;
  const provider = state.provider;
  const previous = state.addressHex;
  try {
    const info = await withTimeout(refreshEnabledWallet(ID_MAP[provider]), 8000);
    if (state.provider !== provider || !state.connected) return;
    const refusal = checkWalletNetworkAtConnect(info.networkId, EXPECTED_WALLET_NETWORK_ID);
    if (refusal || previous !== info.changeAddressHex) {
      await disconnectWallet();
      state = {
        ...state,
        connectionError:
          refusal?.message ?? "Your wallet account changed. Reconnect to refresh your address.",
      };
      emit();
    } else {
      state = { ...state, balanceAda: info.balanceAda };
      emit();
    }
  } catch {
    if (state.provider === provider) {
      await disconnectWallet();
      state = {
        ...state,
        connectionError: "Your wallet is locked or its session changed. Unlock it and reconnect.",
      };
      emit();
    }
  } finally {
    refreshing = false;
  }
}

export async function disconnectWallet() {
  attempts.cancel();
  forgetWalletApis();
  const topic = state.wcTopic;
  state = {
    ...state,
    connected: false,
    connecting: false,
    provider: null,
    address: null,
    addressHex: null,
    balanceAda: 0,
    networkId: null,
    wcTopic: null,
  };
  persist(null);
  emit();
  if (topic) {
    const { disconnectSession } = await import("./walletconnect");
    await withTimeout(disconnectSession(topic), 8000).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Read-only "view by address" mode.
// ---------------------------------------------------------------------------

import type { ParsedCardanoAddress } from "./address";
import { parseCardanoAddress } from "./address";

export type SetViewerResult =
  | { ok: true; parsed: ParsedCardanoAddress }
  | { ok: false; error: string };

export function setViewerAddress(input: string): SetViewerResult {
  const res = parseCardanoAddress(input);
  if (!res.ok) return res;
  state = {
    ...state,
    viewerAddress: res.value.bech32,
    viewerKind: res.value.kind,
    viewerNetworkId: res.value.networkId,
  };
  try {
    window.localStorage.setItem(VIEWER_STORAGE_KEY, res.value.bech32);
  } catch {
    /* ignore */
  }
  emit();
  confirmReferral("wallet_connect");
  return { ok: true, parsed: res.value };
}

export function clearViewer() {
  state = { ...state, viewerAddress: null, viewerKind: null, viewerNetworkId: null };
  try {
    window.localStorage.removeItem(VIEWER_STORAGE_KEY);
  } catch {
    /* ignore */
  }
  emit();
}

function restoreViewer() {
  if (state.viewerAddress) return;
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(VIEWER_STORAGE_KEY);
  } catch {
    return;
  }
  if (!stored) return;
  const res = parseCardanoAddress(stored);
  if (!res.ok) {
    try {
      window.localStorage.removeItem(VIEWER_STORAGE_KEY);
    } catch {
      /* ignore */
    }
    return;
  }
  state = {
    ...state,
    viewerAddress: res.value.bech32,
    viewerKind: res.value.kind,
    viewerNetworkId: res.value.networkId,
  };
  emit();
}

export interface EffectiveAddress {
  address: string | null;
  kind: "payment" | "stake" | null;
  networkId: 0 | 1 | null;
  mode: "signer" | "viewer" | null;
  canSign: boolean;
}

/** Read-anywhere helper: prefer the signer session, fall back to the viewer address. */
export function useEffectiveAddress(): EffectiveAddress {
  const w = useWallet();
  if (w.connected && w.address) {
    return {
      address: w.address,
      kind: "payment",
      networkId: w.networkId,
      mode: "signer",
      canSign: true,
    };
  }
  if (w.viewerAddress) {
    return {
      address: w.viewerAddress,
      kind: w.viewerKind,
      networkId: w.viewerNetworkId,
      mode: "viewer",
      canSign: false,
    };
  }
  return { address: null, kind: null, networkId: null, mode: null, canSign: false };
}

export function useWallet(): WalletState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
    () => serverState,
  );
}

export function getWalletState(): WalletState {
  return state;
}

export function shortAddr(addr: string | null) {
  if (!addr) return "";
  if (addr.length <= 16) return addr;
  return `${addr.slice(0, 10)}…${addr.slice(-6)}`;
}

/**
 * Ask the connected browser wallet to sign a message for its own change
 * address. Used only to prove wallet ownership; never builds a transaction.
 */
export async function signMessageWithConnectedWallet(
  payloadHex: string,
): Promise<{ addressHex: string; signature: string; key: string }> {
  if (!state.connected || !state.provider || !state.addressHex) {
    throw new Error("Connect a browser wallet first.");
  }
  if (state.provider === "WalletConnect") {
    throw new Error("Linking works with a browser wallet extension for now.");
  }
  const provider = state.provider;
  const addressHex = state.addressHex;
  const r = await withTimeout(signDataWithWallet(ID_MAP[provider], addressHex, payloadHex), 60_000);
  if (!state.connected || state.provider !== provider || state.addressHex !== addressHex)
    throw new Error("Wallet changed while signing. Reconnect and start a new ownership challenge.");
  return { addressHex, ...r };
}
