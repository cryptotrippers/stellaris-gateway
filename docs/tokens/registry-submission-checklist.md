# Cardano token metadata submission — readiness checklist

**Not submitted.** This document is for future registration preparation only.

1. Confirm actual Preprod mint transactions and ownership of each policy's signing authority.
2. Verify whether the current Cardano Foundation registry accepts Preprod assets. The main Cardano token registry is not a generic reservation service for unminted token names.
3. Follow the target registry's current schema and signing instructions; do not invent a signature or submit unsigned metadata.
4. Confirm the official display name, ticker, description, logo rights, website, decimals, and links.
5. Generate registry payloads using the real policy ID and asset-name bytes. Sign proofs locally with authorized keys. Never upload private keys.
6. Run schema/signature checks and open a PR against the appropriate official registry only after the above steps pass.
7. Record the PR URL and review outcome; a PR is not an approval or ticker exclusivity.
8. For any eventual mainnet launch, mint and independently verify **new mainnet assets** and submit their distinct identities after security and legal gates are met.

No production registration or minting should be inferred from this checklist.
