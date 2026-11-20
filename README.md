# Primus OKX Verification

A fresh Vite + React application that uses **Primus enterprise zkTLS** (@primuslabs/zktls-js-sdk) to generate and locally verify attestations for an approved data template. It does not use BNB ZK ID, an on-chain registry, or an EVM transaction.

## Architecture

- The browser loads the Primus SDK with the public App ID only.
- The user chooses an EVM address (MetaMask connection or manual entry). The address is an attestation recipient identifier; this app does not sign a wallet challenge or prove address ownership.
- The browser creates a request for the configured Primus Template ID.
- POST /api/primus/sign validates the request and signs it server-side using the Primus App Secret.
- The browser passes the signed request to the Primus extension, receives the attestation, calls verifyAttestation(), checks the recipient, and displays the parsed attestation data.

The signing route checks same-origin requests, limits request size, validates the configured App ID and Template ID, checks the EVM address and recent request timestamp, and applies a best-effort per-instance rate limit. For public production traffic, add a persistent rate limiter or Vercel Firewall rule as appropriate.

## Important: template and KYC claim boundary

This repository intentionally does **not** invent a Template ID or assume a response schema. Add the actual template ID from Primus Developer Hub. Before describing the result as “OKX KYC verified”, confirm that the selected template is an approved OKX source template and review its exact fields and parsing semantics in Primus Developer Hub.

A valid result from verifyAttestation() confirms the Primus attestor signature for the returned attestation. It does not independently prove that an arbitrary template represents KYC, nor does it establish ownership of the wallet address. The app therefore labels its result **Attestation verified** and displays the template data without guessing field meanings.

## Requirements

- Node.js 20+
- npm
- Primus browser extension installed and enabled in the browser that opens the app
- Primus Developer Hub project with an App ID and App Secret
- A real Primus Template ID configured for the data you intend to attest

The browser extension is required by startAttestation(). Install it from the [Primus extension listing](https://chromewebstore.google.com/detail/primus/oeiomhmbaapihbilkfkhmlajkeegnjhe), then reload the app.

## Environment variables

Configure these in Vercel → Project → Settings → Environment Variables.

| Variable | Environment | Purpose |
|---|---|---|
| VITE_PRIMUS_APP_ID | Production (and Preview if used) | Public App ID initialised by the browser SDK |
| VITE_PRIMUS_TEMPLATE_ID | Production (and Preview if used) | Template ID selected in Primus Developer Hub |
| PRIMUS_APP_ID | Production (and Preview if used) | Server-side App ID used when signing |
| PRIMUS_APP_SECRET | Production (and Preview if used) | **Secret** used only by the Vercel function |
| PRIMUS_TEMPLATE_ID | Production (and Preview if used) | Server-side allow-list value for the selected template |

The public and server App IDs must match. The public and server Template IDs must match.

**Never use VITE_PRIMUS_APP_SECRET.** Vite exposes every VITE_* variable in the browser bundle. Do not commit secrets or paste them into frontend code. The previously exposed Primus Secret Key should be revoked in Primus Developer Hub; create a replacement and enter it directly in Vercel.

A blank template ID is deliberately not supplied as a default. Do not copy the SDK demo template ID for an unrelated service.

## Local development

For local work, configure the five variables in your Vercel project and use the Vercel CLI so the /api function runs with the same serverless environment:

    npm install
    npx vercel link
    npx vercel env pull .env.local
    npx vercel dev

Open the local URL printed by Vercel. Do not commit .env.local.

## Build and deploy

Vercel detects the Vite app and the api/primus/sign.ts serverless function. The repository includes a vercel.json build configuration.

    npm install
    npm run typecheck
    npm run build

After the required environment variables and real template are configured, push to GitHub or redeploy from Vercel.

## References

- [Primus zkTLS SDK](https://github.com/primus-labs/zktls-js-sdk)
- [Primus production demo](https://github.com/primus-labs/zktls-demo/tree/main/production-example)
- [Primus zkTLS overview](https://docs.primuslabs.xyz/enterprise/zk-tls-sdk/overview)
- [Primus production guide](https://docs.primuslabs.xyz/enterprise/zk-tls-sdk/production)
- [Primus Developer Hub](https://dev.primuslabs.xyz/)

## Scope

This application provides client-side generation and signature verification of a Primus zkTLS attestation, with server-side request signing. It does not mint an NFT, write to a blockchain, query a BNB registry, or make a KYC determination until a suitable template is configured and its claims are explicitly validated.
