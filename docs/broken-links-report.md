# External Link Audit — Stellaris Finance

Date: 2026-07-15
Method: `curl -sIL -m 8` against every `https://` reference in `src/` and `public/`. Status is the final code after redirects; a `000` means DNS/connect failure.

## Reachable ✅

| Status | URL | Where | Purpose |
|---|---|---|---|
| 200 | https://docs.lovable.dev/features/payments#test-and-live-environments | `src/components/PaymentTestModeBanner.tsx` | Docs link in payment test-mode banner |
| 200 | https://fonts.googleapis.com/css2?family=Inter… | `src/routes/__root.tsx` | Web font stylesheet |
| 403 | https://cardano-mainnet.blockfrost.io/api/v0 | `src/lib/blockfrost.ts` | API host — 403 without auth is expected, host is live |
| 403 | https://cardano-preprod.blockfrost.io/api/v0 | `src/lib/blockfrost.ts` | Same as above (preprod) |
| 403 | https://cardano-preview.blockfrost.io/api/v0 | `src/lib/blockfrost.ts` | Same as above (preview) |
| 403 | https://cardanoscan.io/ | `src/lib/yield-engine.ts` | Explorer host — 403 on root, tx/block paths resolve fine |
| 404 | https://connector-gateway.lovable.dev/stripe | `src/lib/stripe.server.ts` | Gateway base; sub-paths return real responses |
| 404 | https://api.stripe.com | `src/lib/stripe.server.ts` | Stripe API root — 404 by design; `/v1/*` is used |
| 404 | https://fonts.gstatic.com | `src/routes/__root.tsx` | `<link rel="preconnect">` — not fetched as a document |

The `403`/`404` rows are all API hosts that intentionally reject root/unauthenticated hits. They are **not broken**.

## Broken ❌

| Status | URL | Where | Notes |
|---|---|---|---|
| 000 (DNS fail) | https://api.stellaris.fi/v1/assets | `src/routes/developers.tsx` (sample cURL block, line ~56) | Illustrative example inside a code snippet shown to devs — domain is unregistered. Not a clickable link, but printed to users. |

### Placeholder anchors (not broken, but non-functional)

| Location | Href | Action |
|---|---|---|
| `src/routes/developers.tsx:82` — "Full changelog" | `href="#"` | Points nowhere; either route it to a real `/developers/changelog` page or remove. |

## Wallet references

No outbound URLs. Wallet copy in `src/routes/security.tsx` and `src/components/wallet/*` names Lace / Eternl / Ledger / Yubikey without hyperlinks, so nothing to verify.

## Summary

- **1 truly broken link**: `api.stellaris.fi` (illustrative sample in developer docs section — cosmetic).
- **1 placeholder** `href="#"` (Full changelog).
- All real product-facing links (Lovable docs, Google Fonts, Blockfrost, Stripe gateway, Cardanoscan) resolve.

Re-run with:

```bash
rg -no 'https?://[^\s"'\''\`<>)]+' src/ public/ | sort -u
```
