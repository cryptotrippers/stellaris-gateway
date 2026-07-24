import { useSyncExternalStore } from "react";
import { enableWallet, classifyCIP30Error, hasExtension, isWalletEnabled, type CardanoWalletId, type CIP30Error } from "./cip30";
import {
  startPairing,
  disconnectSession,
  isWalletConnectConfigured,
  type Cip34Chain,
  type PairingHandle,
} from "./walletconnect";
import { confirmReferral } from "./referral";

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

export type WalletConnectResult =
  | { ok: true; mock?: false }
  | { ok: false; error: CIP30Error };

export interface WalletState {
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
function emit() { listeners.forEach(l => l()); }

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
    if (provider && provider !== "WalletConnect") window.localStorage.setItem(STORAGE_KEY, provider);
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch { /* ignore quota / private-mode */ }
}

/**
 * Connect to a browser wallet via CIP-30. Returns a typed error on failure —
 * no silent mock fallback.
 */
export async function connectWallet(
  provider: Exclude<WalletProvider, "WalletConnect">,
): Promise<WalletConnectResult> {
  const id = ID_MAP[provider];
  const installed = hasExtension(id);
  if (!installed) {
    return { ok: false, error: { kind: "no_extension", message: `${provider} extension not detected. Install it and reload the page.` } };
  }
  try {
    const info = await enableWallet(id);
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
    persist(provider);
    emit();
    confirmReferral("wallet_connect");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: classifyCIP30Error(e, installed) };
  }
}

/**
 * Try to silently restore the last connected browser wallet (called on app boot).
 * Only re-enables if the extension still reports an active session — never prompts.
 */
export async function restoreWallet(): Promise<void> {
  if (typeof window === "undefined") return;
  restoreViewer();
  if (state.connected) return;
  let stored: string | null = null;
  try { stored = window.localStorage.getItem(STORAGE_KEY); } catch { return; }
  if (!stored) return;
  const provider = stored as Exclude<WalletProvider, "WalletConnect">;
  const id = ID_MAP[provider];
  if (!id) return;
  if (!hasExtension(id)) return;
  const enabled = await isWalletEnabled(id);
  if (!enabled) return;
  try {
    const info = await enableWallet(id);
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
}

/**
 * Begin a CIP-45 WalletConnect pairing. Returns the pairing URI (encode
 * as QR) and a promise that resolves once the mobile wallet approves.
 */
export async function connectWithWalletConnect(chain: Cip34Chain = "preprod"): Promise<PairingHandle> {
  const handle = await startPairing(chain);
  // Fire-and-forget: when approval lands, promote it into wallet state.
  handle.approval
    .then((acct) => {
      state = {
        ...state,
        connected: true,
        provider: "WalletConnect",
        address: acct.stakeAddress,
        addressHex: null,
        balanceAda: 0, // balance requires a follow-up cardano_getBalance RPC
        networkId: acct.networkId,
        wcTopic: acct.topic,
      };
      emit();
      confirmReferral("wallet_connect");
    })
    .catch(() => {
      /* surfaced to caller via handle.approval */
    });
  return handle;
}

export { isWalletConnectConfigured };

export async function disconnectWallet() {
  const topic = state.wcTopic;
  state = {
    ...state,
    connected: false,
    provider: null,
    address: null,
    addressHex: null,
    balanceAda: 0,
    networkId: null,
    wcTopic: null,
  };
  persist(null);
  emit();
  if (topic) await disconnectSession(topic);
}

// ---------------------------------------------------------------------------
// Read-only "view by address" mode.
// ---------------------------------------------------------------------------

import type { ParsedCardanoAddress } from "./address";
import { parseCardanoAddress } from "./address";

export type SetViewerResult = { ok: true; parsed: ParsedCardanoAddress } | { ok: false; error: string };

export function setViewerAddress(input: string): SetViewerResult {
  const res = parseCardanoAddress(input);
  if (!res.ok) return res;
  state = {
    ...state,
    viewerAddress: res.value.bech32,
    viewerKind: res.value.kind,
    viewerNetworkId: res.value.networkId,
  };
  try { window.localStorage.setItem(VIEWER_STORAGE_KEY, res.value.bech32); } catch { /* ignore */ }
  emit();
  confirmReferral("wallet_connect");
  return { ok: true, parsed: res.value };
}

export function clearViewer() {
  state = { ...state, viewerAddress: null, viewerKind: null, viewerNetworkId: null };
  try { window.localStorage.removeItem(VIEWER_STORAGE_KEY); } catch { /* ignore */ }
  emit();
}

function restoreViewer() {
  if (state.viewerAddress) return;
  let stored: string | null = null;
  try { stored = window.localStorage.getItem(VIEWER_STORAGE_KEY); } catch { return; }
  if (!stored) return;
  const res = parseCardanoAddress(stored);
  if (!res.ok) {
    try { window.localStorage.removeItem(VIEWER_STORAGE_KEY); } catch { /* ignore */ }
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
    return { address: w.address, kind: "payment", networkId: w.networkId, mode: "signer", canSign: true };
  }
  if (w.viewerAddress) {
    return { address: w.viewerAddress, kind: w.viewerKind, networkId: w.viewerNetworkId, mode: "viewer", canSign: false };
  }
  return { address: null, kind: null, networkId: null, mode: null, canSign: false };
}


export function useWallet(): WalletState {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    () => state,
    () => state,
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

