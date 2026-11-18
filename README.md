# Primus OKX KYC Credential

A mobile-friendly OKX KYC credential app powered by the official Primus BNB ZKID SDK. The app only displays a KYC level after the SDK returns `on_chain_attested` and the app successfully reads the matching KYC field from the BNB Smart Chain testnet demo registry.

## Current implementation

- MetaMask wallet address connection; no wallet signature or private key handling.
- Primus BNB ZKID SDK initialization.
- Live OKX provider and identity-property discovery from Primus Gateway configuration.
- Re-checks the selected OKX property immediately before proving; no guessed property ID is submitted.
- Primus proof progress, failure diagnostics and on-chain attestation reference.
- Optional read of the OKX KYC-level field from the published BNB Smart Chain testnet demo registry.
- Shareable OKX KYC credential URL; the share page checks the proof reference with Primus and re-reads the KYC field from the registry before showing it as verified.
- The app displays and shares only the KYC level. It does not display or place the six-month trade-history value in the share link.

## Important property limitation

Primus's published BNB ZKID demo currently exposes one OKX identity property described as **OKX KYC + trade count**. The official decoder expects a composite payload containing `kycLevel` and `tradeHistoryLast6Months`.

This application displays and selectively shares only `kycLevel`, but the underlying Primus identity property and on-chain attestation are still the combined property. This is **not** a separate KYC-only cryptographic template. A genuinely KYC-only proof requires Primus to publish and enable a separate KYC-only identity property/template.

## Run locally

Requirements: Node.js 20+, npm, MetaMask, an OKX account, and the Primus browser extension.

1. Install the Primus extension: https://chromewebstore.google.com/detail/primus/oeiomhmbaapihbilkfkhmlajkeegnjhe
2. Sign in to OKX in the same browser profile that has the extension enabled.
3. From the repository root, run:

    npm install
    npm run dev

4. Open the Vite URL (normally http://localhost:5173).
5. Connect MetaMask, discover the live OKX property, then run verification.
6. Complete the Primus extension flow on the OKX source tab.

Never enter an OKX password, API key, secret or verification code into this application.

## App ID

The app uses the public example App ID from Primus's own BNB ZKID SDK demo as a development fallback:

`0x36013DD48B0C1FBFE8906C0AF0CE521DDA69186AB6E6B5017DBF9691F9CF8E5C`

Set `VITE_PRIMUS_APP_ID` in a local `.env` file to use an App ID registered for your own project. App IDs are public identifiers; do not put an App Secret, OKX password, API key, secret, cookie or wallet private key in a Vite environment variable.

The live provider list is authoritative. If the configured App ID does not expose an OKX identity property, the app stops rather than falling back to a hard-coded property.

## Proof and claim boundaries

- The app does not use OKX API keys, private APIs, scraping, or user-entered account credentials to create verified claims.
- The browser's OKX session is used only inside the official Primus extension/source-verification flow.
- The app calls `BnbZkIdClient.init()` and `BnbZkIdClient.prove()` from `@primuslabs/bnb-zkid-sdk`.
- A result is eligible for the credential only when the SDK returns `status: "on_chain_attested"`.
- The app discovers the OKX identity-property ID from live Primus configuration and rechecks it immediately before proof generation.
- The KYC level is shown only when the associated registry payload is successfully read and decoded using the OKX schema in Primus's official demo.
- The six-month trade-history value is not displayed or included in the share URL. However, it remains part of the underlying composite identity-property attestation and registry payload.
- Shared credential pages call `queryProofResult()`, compare the provider/property, and re-read the KYC field from the registry before displaying the verified badge.
- The share URL is a presentation/transport format, not a standalone cryptographic verifier. Recipients should check the proof reference with Primus before relying on the claim.

## Registry read

The decoder follows the public Primus demo's BNB Smart Chain testnet registry example:

- Chain: BNB Smart Chain testnet (chain ID 97)
- Registry: `0x9569299A8877Bc155232cF5Aa50AF42F9Fc32C7C`
- OKX identity property: `0x289d4fed0b3ecb26e711e6d1200b46f1d67f2da4847b03f99aa8584706933195`

Before production, confirm the production chain, registry address, provider/property identifiers and exact payload schema with Primus. Do not label testnet registry reads as mainnet verification.

## Commands

    npm run typecheck
    npm run build

## Official references

- BNB ZKID SDK: https://github.com/primus-labs/BNB-ZKID-SDK
- Official BNB ZKID SDK demo: https://github.com/primus-labs/BNB-ZKID-SDK-Demo
- OKX property decoder: https://github.com/primus-labs/BNB-ZKID-SDK-Demo/blob/main/src/decode-attestation.ts
- Primus Developer Hub: https://dev.primuslabs.xyz/
- Primus extension: https://chromewebstore.google.com/detail/primus/oeiomhmbaapihbilkfkhmlajkeegnjhe

## Not included

This is a development integration, not a production launch. It does not mint NFTs or claim any financial standing, account balance, trading performance, or other OKX attributes outside the KYC level decoded from the Primus registry.
