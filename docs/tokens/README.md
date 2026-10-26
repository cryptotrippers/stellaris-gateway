# TSRA / sTSRA — Cardano Preprod registration preparation

Status: **DRAFT — NOT MINTED OR REGISTERED**. Network: **Cardano Preprod only**.

This package documents a proposed test issuance. It does not assert that tokens, reserves, staking rights, or financial claims exist. Do not display either token as live or backed by assets.

## Proposed asset identities

| Field | TSRA | sTSRA |
| --- | --- | --- |
| Display name | TESSRA Preprod Test Token | Staked TESSRA Preprod Test Token |
| Ticker (provisional) | TSRA | sTSRA |
| Network | preprod | preprod |
| Policy ID | PENDING | PENDING |
| Asset name (UTF-8) | TSRA | sTSRA |
| Asset-name hex | 54535241 | 7354535241 |
| Fingerprint | PENDING | PENDING |
| Mint transaction | PENDING | PENDING |
| Decimals | PENDING tokenomics approval | PENDING tokenomics approval |
| Logo | PENDING approved asset | PENDING approved asset |
| Public website | https://stellarischain.com | https://stellarischain.com |

**Do not mint** until token economics, policy ownership, burn rules, decimals, treasury custody, and regulatory descriptions are reviewed and approved. sTSRA must not imply staking yield until its redemption mechanics and underlying contract are specified and tested.

## Preprod go/no-go checklist

- [ ] Confirm names and metadata are approved for testnet use.
- [ ] Select policy type and verify expiration/reissuance requirements; use distinct policies for the two assets unless formally justified.
- [ ] Document initial supply and decimals as immutable asset parameters.
- [ ] Store signing keys only in operator-controlled wallets/hardware; never commit keys or seed phrases.
- [ ] Ensure network guards refuse mainnet and dry-run is the default.
- [ ] Run tests and independently review mint transaction body before signing.
- [ ] Mint a minimal test amount on Preprod using an authorized wallet.
- [ ] Wait for chain confirmation, record policy IDs, asset names, fingerprints, tx hashes and recipient address.
- [ ] Verify assets using two independent Preprod explorers/indexers.
- [ ] Prepare signed metadata according to the *current* applicable registry instructions; testnet registry acceptance is not assumed.
- [ ] Do not make a mainnet registration submission using Preprod policy IDs.

## Source of truth

The Cardano native asset identifier is the policy ID concatenated with the asset-name bytes; a display ticker is not globally reserved. See `NETWORK.md` for the existing mainnet prohibition. Never weaken it.

## Recording results

Populate `preprod-deployment-record.template.json` only with confirmed chain-derived values. Do not insert placeholder IDs into production code. Link a registry pull request only after it actually exists.
