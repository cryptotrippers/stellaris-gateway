/**
 * Security Suite S1 — transaction intent guard (pure core).
 *
 * Every transaction the app asks a wallet to sign is decoded here first and
 * checked against (a) what the calling action declared it would do and
 * (b) the trust view of reviewed scripts and addresses. Anything else in the
 * transaction — an extra payee, a surprise mint, a foreign network, an
 * unexpected withdrawal, certificate or signer, an inflated spend — is a
 * violation and the wallet is never asked to sign.
 *
 * Decoding uses Cardano's own CML (bundled with Lucid Evolution), passed in
 * so this module has no runtime dependency and runs in tests. No custom
 * parsing, no cryptography.
 */
import type { CML as CMLNamespace } from "@lucid-evolution/lucid";
import type { TrustView } from "./tx-trust.shared";

type Cml = typeof CMLNamespace;

export type Assets = Record<string, bigint>;

export interface DecodedOutput {
  readonly address: string;
  readonly networkId: number | null;
  /** "key" | "script" | null (Byron or unknown). */
  readonly paymentKind: "key" | "script" | null;
  readonly paymentHash: string | null;
  readonly assets: Assets;
  /** Hash of an attached reference script, or null. */
  readonly scriptRefHash: string | null;
}

export interface DecodedTx {
  readonly networkId: number | null;
  readonly inputs: readonly string[];
  readonly referenceInputs: readonly string[];
  readonly outputs: readonly DecodedOutput[];
  readonly mint: Assets;
  readonly withdrawals: readonly {
    address: string;
    paymentKind: "key" | "script";
    hash: string;
    amount: bigint;
  }[];
  readonly certificateCount: number;
  readonly governanceActionCount: number;
  readonly requiredSigners: readonly string[];
  readonly fee: bigint;
  readonly totalCollateral: bigint | null;
  readonly collateralReturn: DecodedOutput | null;
}

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

function add(into: Assets, unit: string, q: bigint) {
  const next = (into[unit] ?? 0n) + q;
  if (next === 0n) delete into[unit];
  else into[unit] = next;
}

function decodeValue(value: Cml["Value"]["prototype"]): Assets {
  const out: Assets = {};
  add(out, "lovelace", value.coin());
  const ma = value.multi_asset();
  const pids = ma.keys();
  for (let i = 0; i < pids.len(); i++) {
    const pid = pids.get(i);
    const names = ma.get_assets(pid);
    if (!names) continue;
    const keys = names.keys();
    for (let j = 0; j < keys.len(); j++) {
      const name = keys.get(j);
      add(out, pid.to_hex() + hex(name.to_raw_bytes()), names.get(name) ?? 0n);
    }
  }
  return out;
}

function decodeAddress(cml: Cml, bech32: string) {
  const a = cml.Address.from_bech32(bech32);
  let networkId: number | null = null;
  try {
    networkId = a.network_id();
  } catch {
    networkId = null;
  }
  const cred = a.payment_cred();
  let paymentKind: DecodedOutput["paymentKind"] = null;
  let paymentHash: string | null = null;
  if (cred) {
    if (cred.kind() === cml.CredentialKind.Script) {
      paymentKind = "script";
      paymentHash = cred.as_script()!.to_hex();
    } else {
      paymentKind = "key";
      paymentHash = cred.as_pub_key()!.to_hex();
    }
  }
  return { networkId, paymentKind, paymentHash };
}

function decodeOutput(cml: Cml, o: Cml["TransactionOutput"]["prototype"]): DecodedOutput {
  const address = o.address().to_bech32();
  const ref = o.script_ref();
  return {
    address,
    ...decodeAddress(cml, address),
    assets: decodeValue(o.amount()),
    scriptRefHash: ref ? ref.hash().to_hex() : null,
  };
}

const inputRef = (i: Cml["TransactionInput"]["prototype"]) =>
  `${i.transaction_id().to_hex()}#${i.index().toString()}`;

/** Decode an unsigned (or signed) transaction CBOR into plain data. */
export function decodeTx(cml: Cml, txCborHex: string): DecodedTx {
  const body = cml.Transaction.from_cbor_hex(txCborHex).body();

  const inputs: string[] = [];
  const ins = body.inputs();
  for (let i = 0; i < ins.len(); i++) inputs.push(inputRef(ins.get(i)));

  const referenceInputs: string[] = [];
  const refs = body.reference_inputs();
  if (refs) for (let i = 0; i < refs.len(); i++) referenceInputs.push(inputRef(refs.get(i)));

  const outputs: DecodedOutput[] = [];
  const outs = body.outputs();
  for (let i = 0; i < outs.len(); i++) outputs.push(decodeOutput(cml, outs.get(i)));

  const mint: Assets = {};
  const m = body.mint();
  if (m) {
    const pids = m.keys();
    for (let i = 0; i < pids.len(); i++) {
      const pid = pids.get(i);
      const names = m.get_assets(pid);
      if (!names) continue;
      const keys = names.keys();
      for (let j = 0; j < keys.len(); j++) {
        const name = keys.get(j);
        add(mint, pid.to_hex() + hex(name.to_raw_bytes()), names.get(name) ?? 0n);
      }
    }
  }

  const withdrawals: DecodedTx["withdrawals"][number][] = [];
  const w = body.withdrawals();
  if (w) {
    const keys = w.keys();
    for (let i = 0; i < keys.len(); i++) {
      const ra = keys.get(i);
      const cred = ra.payment();
      const isScript = cred.kind() === cml.CredentialKind.Script;
      withdrawals.push({
        address: ra.to_address().to_bech32(),
        paymentKind: isScript ? "script" : "key",
        hash: isScript ? cred.as_script()!.to_hex() : cred.as_pub_key()!.to_hex(),
        amount: w.get(ra) ?? 0n,
      });
    }
  }

  const certs = body.certs();
  const votes = body.voting_procedures();
  const proposals = body.proposal_procedures();
  const governanceActionCount =
    (votes ? votes.len() : 0) +
    (proposals ? proposals.len() : 0) +
    (body.donation() !== undefined ? 1 : 0) +
    (body.current_treasury_value() !== undefined ? 1 : 0);

  const requiredSigners: string[] = [];
  const rs = body.required_signers();
  if (rs) for (let i = 0; i < rs.len(); i++) requiredSigners.push(rs.get(i).to_hex());

  const net = body.network_id();
  const cr = body.collateral_return();

  return {
    networkId: net ? Number(net.network()) : null,
    inputs,
    referenceInputs,
    outputs,
    mint,
    withdrawals,
    certificateCount: certs ? certs.len() : 0,
    governanceActionCount,
    requiredSigners,
    fee: body.fee(),
    totalCollateral: body.total_collateral() ?? null,
    collateralReturn: cr ? decodeOutput(cml, cr) : null,
  };
}

/** What the calling action says the transaction will do. */
export interface TxIntent {
  /** Short action name for messages and logs, e.g. "vault.deposit". */
  readonly action: string;
  /** Exact addresses, besides the wallet's own, that may receive outputs. */
  readonly pay?: readonly string[];
  /** Exact mint (+) and burn (−) per unit. Absent = nothing may be minted. */
  readonly mint?: Readonly<Assets>;
  /** Most that may leave the wallet, not counting the network fee. */
  readonly spend?: { readonly lovelace?: bigint; readonly assets?: Readonly<Assets> };
  /** Highest acceptable network fee. Default 3 ADA. */
  readonly maxFee?: bigint;
  /** Key hashes, besides the wallet's own, that may be required signers. */
  readonly extraSigners?: readonly string[];
  /** Reward addresses that may be withdrawn from (withdraw-zero included). */
  readonly withdrawals?: readonly string[];
  readonly allowCertificates?: boolean;
  /** Outputs may carry trusted reference scripts (publishing flows). */
  readonly allowScriptRefs?: boolean;
  /** Co-signing someone else's draft: nothing of this wallet may be spent. */
  readonly coSign?: boolean;
}

export interface WalletView {
  readonly addresses: readonly string[];
  readonly keyHashes: readonly string[];
  /** The wallet's UTxOs, keyed `${txHash}#${index}`. */
  readonly utxos: ReadonlyMap<string, Assets>;
}

export type ViolationCode =
  | "wrong_network"
  | "unexpected_destination"
  | "untrusted_script"
  | "unexpected_script_ref"
  | "unexpected_mint"
  | "untrusted_policy"
  | "unexpected_withdrawal"
  | "unexpected_certificate"
  | "governance_action"
  | "unexpected_signer"
  | "fee_too_high"
  | "overspend"
  | "cosign_spends_wallet"
  | "collateral_risk";

export interface Violation {
  readonly code: ViolationCode;
  readonly detail: string;
}

export const DEFAULT_MAX_FEE = 3_000_000n;
export const MAX_COLLATERAL = 5_000_000n;
export const PREPROD_NETWORK_ID = 0;

const short = (s: string) => (s.length > 24 ? `${s.slice(0, 14)}…${s.slice(-6)}` : s);
const policyOf = (unit: string) => unit.slice(0, 56);

/** Check a decoded transaction. An empty list means it may be signed. */
export function checkTx(
  tx: DecodedTx,
  intent: TxIntent,
  wallet: WalletView,
  trust: TrustView,
): Violation[] {
  const v: Violation[] = [];
  const own = new Set(wallet.addresses);
  const pay = new Set(intent.pay ?? []);

  // 1. Network: Preprod only, on the body and on every address.
  if (tx.networkId !== null && tx.networkId !== PREPROD_NETWORK_ID) {
    v.push({ code: "wrong_network", detail: `transaction network id ${tx.networkId}` });
  }
  const outs = tx.collateralReturn ? [...tx.outputs, tx.collateralReturn] : tx.outputs;
  for (const o of outs) {
    if (o.networkId !== PREPROD_NETWORK_ID) {
      v.push({
        code: "wrong_network",
        detail: `output to ${short(o.address)} is not a Preprod address`,
      });
    }
  }

  // 2. Destinations: the wallet itself, or a declared address. A declared
  //    script address must also be trusted.
  for (const o of tx.outputs) {
    if (!own.has(o.address)) {
      if (!pay.has(o.address)) {
        v.push({
          code: "unexpected_destination",
          detail: `pays ${short(o.address)}, which ${intent.action} did not declare`,
        });
      } else if (
        o.paymentKind === "script" &&
        !trust.script(o.paymentHash!) &&
        !trust.address(o.address)
      ) {
        v.push({
          code: "untrusted_script",
          detail: `script ${short(o.paymentHash!)} is not a reviewed script`,
        });
      } else if (o.paymentKind === null) {
        v.push({
          code: "unexpected_destination",
          detail: `pays a legacy address ${short(o.address)}`,
        });
      }
    }
    // 3. Reference scripts only when declared, and only reviewed ones.
    if (o.scriptRefHash !== null) {
      if (!intent.allowScriptRefs) {
        v.push({
          code: "unexpected_script_ref",
          detail: `output carries script ${short(o.scriptRefHash)}`,
        });
      } else if (!trust.script(o.scriptRefHash)) {
        v.push({
          code: "untrusted_script",
          detail: `reference script ${short(o.scriptRefHash)} is not reviewed`,
        });
      }
    }
  }

  // 4. Mint and burn: exactly as declared, under reviewed policies only.
  const want = intent.mint ?? {};
  const units = new Set([...Object.keys(tx.mint), ...Object.keys(want)]);
  for (const u of units) {
    const got = tx.mint[u] ?? 0n;
    const exp = want[u] ?? 0n;
    if (got !== exp) {
      v.push({
        code: "unexpected_mint",
        detail: `mints ${got} of ${short(u)}; ${intent.action} declared ${exp}`,
      });
    }
  }
  for (const u of Object.keys(tx.mint)) {
    if (!trust.script(policyOf(u))) {
      v.push({ code: "untrusted_policy", detail: `policy ${short(policyOf(u))} is not reviewed` });
    }
  }

  // 5. Withdrawals: declared reward addresses of reviewed scripts only.
  const allowedW = new Set(intent.withdrawals ?? []);
  for (const w of tx.withdrawals) {
    if (!allowedW.has(w.address)) {
      v.push({ code: "unexpected_withdrawal", detail: `withdraws from ${short(w.address)}` });
    } else if (w.paymentKind === "script" && !trust.script(w.hash) && !trust.reward(w.address)) {
      v.push({
        code: "untrusted_script",
        detail: `withdrawal script ${short(w.hash)} is not reviewed`,
      });
    }
  }

  // 6. Certificates only when declared; governance actions never.
  if (tx.certificateCount > 0 && !intent.allowCertificates) {
    v.push({ code: "unexpected_certificate", detail: `${tx.certificateCount} certificate(s)` });
  }
  if (tx.governanceActionCount > 0) {
    v.push({
      code: "governance_action",
      detail: "votes, proposals or treasury actions are never signed here",
    });
  }

  // 7. Signers: the wallet, or declared co-signers.
  const signers = new Set([...wallet.keyHashes, ...(intent.extraSigners ?? [])]);
  for (const s of tx.requiredSigners) {
    if (!signers.has(s))
      v.push({ code: "unexpected_signer", detail: `requires signer ${short(s)}` });
  }

  // 8. Fee.
  const maxFee = intent.maxFee ?? DEFAULT_MAX_FEE;
  if (tx.fee > maxFee)
    v.push({ code: "fee_too_high", detail: `fee ${tx.fee} lovelace exceeds ${maxFee}` });

  // 9. What leaves the wallet: wallet inputs minus outputs back to the wallet.
  //    Freshly minted tokens paid to the wallet are received, not returned,
  //    so they do not offset what the wallet put in.
  const walletIn: Assets = {};
  const walletOut: Assets = {};
  let spendsWallet = false;
  for (const i of tx.inputs) {
    const a = wallet.utxos.get(i);
    if (!a) continue;
    spendsWallet = true;
    for (const [u, q] of Object.entries(a)) add(walletIn, u, q);
  }
  for (const o of tx.outputs) {
    if (own.has(o.address)) for (const [u, q] of Object.entries(o.assets)) add(walletOut, u, q);
  }
  if (intent.coSign && spendsWallet) {
    v.push({
      code: "cosign_spends_wallet",
      detail: "a co-signed draft spends this wallet's funds",
    });
  }
  for (const [u, inQ] of Object.entries(walletIn)) {
    const minted = tx.mint[u] !== undefined && tx.mint[u] > 0n ? tx.mint[u] : 0n;
    const returned = (walletOut[u] ?? 0n) - minted;
    const q = inQ - (returned > 0n ? returned : 0n);
    if (q <= 0n) continue;
    const declaredBurn = want[u] !== undefined && want[u] < 0n ? -want[u] : 0n;
    const allowance =
      u === "lovelace"
        ? (intent.spend?.lovelace ?? 0n) + tx.fee
        : (intent.spend?.assets?.[u] ?? 0n) + declaredBurn;
    if (q > allowance) {
      v.push({
        code: "overspend",
        detail: `${q} of ${u === "lovelace" ? "lovelace" : short(u)} leaves the wallet; allowed ${allowance}`,
      });
    }
  }

  // 10. Collateral: bounded, and any return comes back to the wallet.
  if (tx.totalCollateral !== null && tx.totalCollateral > MAX_COLLATERAL) {
    v.push({
      code: "collateral_risk",
      detail: `collateral ${tx.totalCollateral} exceeds ${MAX_COLLATERAL}`,
    });
  }
  if (tx.collateralReturn && !own.has(tx.collateralReturn.address)) {
    v.push({
      code: "collateral_risk",
      detail: `collateral returns to ${short(tx.collateralReturn.address)}`,
    });
  }

  return v;
}

const ada = (lovelace: bigint) => {
  const sign = lovelace < 0n ? "-" : "";
  const a = lovelace < 0n ? -lovelace : lovelace;
  return `${sign}${a / 1_000_000n}.${(a % 1_000_000n).toString().padStart(6, "0")} ADA`;
};

/** Plain-English lines describing a transaction, for a confirmation dialog. */
export function summariseTx(tx: DecodedTx, wallet: WalletView, trust: TrustView): string[] {
  const own = new Set(wallet.addresses);
  const lines: string[] = [];
  for (const o of tx.outputs) {
    if (own.has(o.address)) continue;
    const label =
      trust.address(o.address) ??
      (o.paymentKind === "script" && o.paymentHash ? trust.script(o.paymentHash) : null) ??
      short(o.address);
    const tokens = Object.entries(o.assets).filter(([u]) => u !== "lovelace");
    const tokenText = tokens.length
      ? ` and ${tokens.map(([u, q]) => `${q} × ${short(u)}`).join(", ")}`
      : "";
    lines.push(`Sends ${ada(o.assets.lovelace ?? 0n)}${tokenText} to ${label}`);
  }
  for (const [u, q] of Object.entries(tx.mint)) {
    const label = trust.script(policyOf(u)) ?? short(policyOf(u));
    lines.push(`${q > 0n ? "Mints" : "Burns"} ${q > 0n ? q : -q} × ${short(u)} (${label})`);
  }
  lines.push(`Network fee ${ada(tx.fee)}`);
  return lines;
}

export class TxIntentRejected extends Error {
  constructor(
    readonly action: string,
    readonly violations: readonly Violation[],
  ) {
    super(
      `Stopped before signing: this ${action} transaction does not match what the app expected. ` +
        violations.map((x) => x.detail).join("; "),
    );
    this.name = "TxIntentRejected";
  }
}
