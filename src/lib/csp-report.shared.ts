/**
 * Security Suite S2.1 — parse and sanitise Content Security Policy reports.
 *
 * Browsers POST a report each time the page loads something the policy does
 * not allow. We keep only what is needed to tighten the policy: which
 * directive, which ORIGIN was blocked (never a full URL), on which page PATH
 * (never a query string or fragment), and whether the policy was enforcing.
 * Everything else in the report (code samples, line numbers, referrers,
 * full URLs that can carry tokens or personal data) is dropped here.
 *
 * Two formats are accepted:
 *  - legacy `report-uri`: `{"csp-report": {...}}` (application/csp-report)
 *  - Reporting API `report-to`: `[{"type":"csp-violation","body":{...}}]`
 *    (application/reports+json)
 */

export interface CspRecord {
  readonly directive: string;
  /** "inline" | "eval" | "data" | "blob" | an origin like "https://x.com" | "other". */
  readonly blocked: string;
  /** Page path only, e.g. "/marketplace". */
  readonly documentPath: string;
  readonly disposition: "enforce" | "report";
}

export const MAX_BODY_BYTES = 16_384;
export const MAX_RECORDS = 20;

const DIRECTIVE = /^[a-z-]{3,40}$/;

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Reduce a blocked URI to something safe to store. */
export function blockedLabel(raw: string): string {
  const v = raw.trim().toLowerCase();
  if (v === "" || v === "inline" || v === "'unsafe-inline'") return "inline";
  if (v === "eval" || v === "'unsafe-eval'") return "eval";
  if (v === "wasm-eval" || v === "'wasm-unsafe-eval'") return "wasm-eval";
  if (v === "data" || v.startsWith("data:")) return "data";
  if (v === "blob" || v.startsWith("blob:")) return "blob";
  if (v === "self") return "self";
  try {
    const u = new URL(raw.trim());
    if (
      u.protocol === "http:" ||
      u.protocol === "https:" ||
      u.protocol === "wss:" ||
      u.protocol === "ws:"
    ) {
      return u.origin.slice(0, 200);
    }
    return u.protocol.replace(/[^a-z-:]/g, "").slice(0, 20) || "other";
  } catch {
    return "other";
  }
}

/** Reduce a document URL to its path, without query or fragment. */
export function pathOf(raw: string): string {
  try {
    const p = new URL(raw).pathname;
    // Collapse long ids (UUIDs, hashes, addresses) so paths group and leak nothing.
    return p
      .split("/")
      .map((seg) => (seg.length > 24 || /^[0-9a-f-]{16,}$/i.test(seg) ? ":id" : seg))
      .join("/")
      .slice(0, 200);
  } catch {
    return "/";
  }
}

function directiveOf(raw: string): string {
  // "script-src-elem" stays as is; "script-src 'self' …" (old browsers) → first word.
  const d = raw.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return DIRECTIVE.test(d) ? d : "unknown";
}

function fromLegacy(r: Record<string, unknown>): CspRecord {
  return {
    directive: directiveOf(str(r["effective-directive"]) || str(r["violated-directive"])),
    blocked: blockedLabel(str(r["blocked-uri"])),
    documentPath: pathOf(str(r["document-uri"])),
    disposition: str(r["disposition"]) === "enforce" ? "enforce" : "report",
  };
}

function fromReportingApi(b: Record<string, unknown>): CspRecord {
  return {
    directive: directiveOf(str(b.effectiveDirective)),
    blocked: blockedLabel(str(b.blockedURL)),
    documentPath: pathOf(str(b.documentURL)),
    disposition: str(b.disposition) === "enforce" ? "enforce" : "report",
  };
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Parse a report body. Returns at most MAX_RECORDS sanitised records; never throws. */
export function parseCspReports(body: string): CspRecord[] {
  if (!body || body.length > MAX_BODY_BYTES) return [];
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return [];
  }
  const out: CspRecord[] = [];
  if (isObj(data) && isObj(data["csp-report"])) {
    out.push(fromLegacy(data["csp-report"]));
  } else if (Array.isArray(data)) {
    for (const item of data) {
      if (out.length >= MAX_RECORDS) break;
      if (isObj(item) && item.type === "csp-violation" && isObj(item.body)) {
        out.push(fromReportingApi(item.body));
      }
    }
  }
  return out;
}

/** The path the browser posts reports to. Exempt from the CSRF guard (/api/public/). */
export const CSP_REPORT_PATH = "/api/public/csp-report";
