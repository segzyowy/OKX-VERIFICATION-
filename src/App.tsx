import { useEffect, useMemo, useState } from "react";
import {
  BnbZkIdClient,
  BnbZkIdProveError,
  type ProveSuccessResult
} from "@primuslabs/bnb-zkid-sdk";
import {
  makePassportUrl,
  readOkxAttestedKyc,
  readPassportFromUrl,
  type OkxKycAttestedData,
  type PrimusAttestedResult,
  type ShareablePassport
} from "./verification";

const DEFAULT_TEST_APP_ID =
  "0x36013DD48B0C1FBFE8906C0AF0CE521DDA69186AB6E6B5017DBF9691F9CF8E5C";
const APP_ID = import.meta.env.VITE_PRIMUS_APP_ID?.trim() || DEFAULT_TEST_APP_ID;
const OKX_IDENTITY_PROPERTY_HEX =
  "0x289d4fed0b3ecb26e711e6d1200b46f1d67f2da4847b03f99aa8584706933195";
const PRIMUS_EXTENSION_URL =
  "https://chromewebstore.google.com/detail/primus/oeiomhmbaapihbilkfkhmlajkeegnjhe";

type EthereumProvider = {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
};

type OkxProperty = {
  providerId: string;
  providerLabel: string;
  identityPropertyId: string;
  description: string;
};

type ProgressStatus =
  | "idle"
  | "initializing"
  | "data_verifying"
  | "proof_generating"
  | "on_chain_attested"
  | "failed";

type SharedVerification = "checking" | "verified" | "failed";

type GatewayResponseDiagnostic = {
  httpStatus: number;
  responseStatus?: string;
  proofRequestId?: string;
  errorCategory?: string;
  errorCode?: string;
  errorMessage?: string;
};

type ProofDiagnostic = {
  clientRequestId: string;
  providerId: string;
  identityPropertyId: string;
  progress: string[];
  errorCode?: string;
  sdkClientRequestId?: string;
  proofRequestId?: string;
  gatewayResponse?: GatewayResponseDiagnostic;
};

function captureGatewayProofResponse(
  onCaptured: (details: GatewayResponseDiagnostic) => void
): () => void {
  const originalFetch = window.fetch;
  const wrappedFetch: typeof window.fetch = async (...args) => {
    const [input, init] = args;
    const response = await originalFetch(...args);

    try {
      const requestUrl = input instanceof Request ? input.url : input.toString();
      const requestMethod = (init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
      const parsedUrl = new URL(requestUrl, window.location.href);

      if (
        requestMethod === "POST" &&
        parsedUrl.origin === "https://zk-id.brevis.network" &&
        parsedUrl.pathname === "/v1/proof-requests"
      ) {
        const body: unknown = await response.clone().json();
        if (body !== null && typeof body === "object" && !Array.isArray(body)) {
          const record = body as Record<string, unknown>;
          const error = record.error !== null && typeof record.error === "object" && !Array.isArray(record.error)
            ? record.error as Record<string, unknown>
            : undefined;
          const message = typeof error?.message === "string"
            ? error.message
            : typeof error?.detail === "string"
              ? error.detail
              : undefined;

          onCaptured({
            httpStatus: response.status,
            ...(typeof record.status === "string" ? { responseStatus: record.status } : {}),
            ...(typeof record.proofRequestId === "string" && record.proofRequestId.trim()
              ? { proofRequestId: record.proofRequestId.trim() }
              : {}),
            ...(typeof error?.category === "string" ? { errorCategory: error.category } : {}),
            ...(typeof error?.code === "string" ? { errorCode: error.code } : {}),
            ...(message ? { errorMessage: message.slice(0, 500) } : {})
          });
        } else {
          onCaptured({ httpStatus: response.status });
        }
      }
    } catch {
      // Diagnostic capture must never interrupt the SDK's original fetch response.
    }

    return response;
  };

  window.fetch = wrappedFetch;
  return () => {
    if (window.fetch === wrappedFetch) {
      window.fetch = originalFetch;
    }
  };
}

function getEthereum(): EthereumProvider | undefined {
  return (window as Window & { ethereum?: EthereumProvider }).ethereum;
}

function formatError(error: unknown): string {
  if (error instanceof BnbZkIdProveError) {
    return error.message + (error.code ? " (code " + error.code + ")" : "");
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

function discoverOkxProperties(
  providers: Awaited<ReturnType<BnbZkIdClient["init"]>>["providers"]
): OkxProperty[] {
  const rows: OkxProperty[] = [];
  for (const provider of providers) {
    const providerLabel = provider.description?.trim() || provider.id;
    for (const property of provider.properties) {
      const id = property.id.trim();
      const description = property.description?.trim() || id;
      if (!id) continue;

      const isOkxProperty =
        id.toLowerCase() === OKX_IDENTITY_PROPERTY_HEX ||
        id.toLowerCase() === "okx_trade_kyc" ||
        description.toLowerCase().includes("okx") ||
        (providerLabel.toLowerCase().includes("okx") && /kyc|trade/i.test(description));
      if (!isOkxProperty) continue;

      rows.push({
        providerId: provider.id,
        providerLabel,
        identityPropertyId: id,
        description
      });
    }
  }
  return rows;
}

function statusLabel(status: ProgressStatus): string {
  const labels: Record<ProgressStatus, string> = {
    idle: "Ready to verify",
    initializing: "Connecting to Primus",
    data_verifying: "Verifying OKX data with zkTLS",
    proof_generating: "Generating the ZK proof",
    on_chain_attested: "Primus proof attested",
    failed: "Verification failed"
  };
  return labels[status];
}

function shortAddress(value?: string): string {
  if (!value) return "Not disclosed";
  return value.slice(0, 6) + "…" + value.slice(-4);
}

function SharedKycView({ passport }: { passport: ShareablePassport }) {
  const [verificationState, setVerificationState] = useState<SharedVerification>("checking");
  const [verificationMessage, setVerificationMessage] = useState(
    "Checking the proof reference with Primus. Keep the Primus extension enabled."
  );
  const [currentKyc, setCurrentKyc] = useState<OkxKycAttestedData | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const client = new BnbZkIdClient();
        await client.init({ appId: APP_ID });
        const result = await client.queryProofResult({ proofRequestId: passport.proofRequestId });
        if (result.status !== "on_chain_attested") {
          throw new Error("Primus does not currently report this proof as on-chain attested.");
        }
        if (
          result.providerId !== passport.providerId ||
          result.identityPropertyId !== passport.identityPropertyId
        ) {
          throw new Error("The shared OKX provider or identity property does not match the Primus proof.");
        }
        if (
          passport.walletAddress &&
          result.walletAddress.toLowerCase() !== passport.walletAddress.toLowerCase()
        ) {
          throw new Error("The disclosed wallet address does not match the Primus proof.");
        }

        if (passport.kyc) {
          const liveKyc = await readOkxAttestedKyc(result as PrimusAttestedResult);
          if (
            liveKyc.kycLevel !== passport.kyc.kycLevel ||
            liveKyc.registryTimestamp !== passport.kyc.registryTimestamp ||
            liveKyc.registry.toLowerCase() !== passport.kyc.registry.toLowerCase() ||
            liveKyc.chainId !== passport.kyc.chainId
          ) {
            throw new Error("The shared KYC level does not match the current Primus registry payload.");
          }
          if (!cancelled) setCurrentKyc(liveKyc);
        }

        if (!cancelled) {
          setVerificationState("verified");
          setVerificationMessage("Primus confirmed the on-chain proof reference and shared OKX KYC field.");
        }
      } catch (error) {
        if (!cancelled) {
          setVerificationState("failed");
          setVerificationMessage(formatError(error));
        }
      }
    })();
    return () => { cancelled = true; };
  }, [passport]);

  const sealText =
    verificationState === "verified"
      ? "VERIFIED BY PRIMUS"
      : verificationState === "checking"
        ? "CHECKING PRIMUS PROOF"
        : "NOT VERIFIED";

  return (
    <main className="page-shell share-shell">
      <header className="topbar">
        <a className="brand" href={window.location.pathname}>
          <span className="brand-mark">P</span>
          <span>PRIMUS <b>OKX KYC</b></span>
        </a>
        <span className="network-pill"><i /> Primus proof lookup</span>
      </header>
      <section className="passport-card public-passport">
        <div className="passport-orbit">✳</div>
        <p className="eyebrow">VERIFIABLE OKX ACCOUNT CREDENTIAL</p>
        <h1>OKX KYC<br /><span>Credential</span></h1>
        <div className={"verified-seal " + verificationState}>
          <span>{verificationState === "verified" ? "✓" : verificationState === "checking" ? "…" : "!"}</span>
          <b>{sealText}</b>
        </div>
        <div className={"passport-check-alert " + verificationState}>{verificationMessage}</div>
        <div className="credential-list">
          <div className="credential-row">
            <div><span className="credential-icon">OKX</span></div>
            <div className="credential-copy">
              <b>OKX KYC identity property</b>
              <small>{passport.identityPropertyId}</small>
            </div>
            {verificationState === "verified" ? <span className="verified-tag">VERIFIED</span> : <span className="pending-tag">PENDING</span>}
          </div>
          {currentKyc ? (
            <div className="credential-row">
              <div><span className="credential-icon">KYC</span></div>
              <div className="credential-copy">
                <b>KYC level</b>
                <small>Decoded from the Primus BNB testnet registry</small>
              </div>
              <strong className="credential-value">{currentKyc.kycLevel}</strong>
            </div>
          ) : (
            <p className="muted-note">This passport shares the Primus proof reference without a decoded KYC level.</p>
          )}
        </div>
        <div className="passport-meta">
          <div><small>PROOF REQUEST</small><b>{passport.proofRequestId}</b></div>
          <div><small>WALLET</small><b>{shortAddress(passport.walletAddress)}</b></div>
          <div><small>ISSUER</small><b>{passport.issuer}</b></div>
        </div>
        <p className="fine-print">
          The Primus OKX identity property currently bundles KYC level with six-month trade-history data. This page displays and shares only the KYC level; it does not claim to use a separate KYC-only cryptographic property.
        </p>
      </section>
      <p className="share-footer">Powered by Primus zkTLS · BNB ZKID</p>
    </main>
  );
}

export default function App() {
  const [walletAddress, setWalletAddress] = useState("");
  const [properties, setProperties] = useState<OkxProperty[]>([]);
  const [selectedPropertyId, setSelectedPropertyId] = useState("");
  const [loadingProperties, setLoadingProperties] = useState(false);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<ProgressStatus>("idle");
  const [proof, setProof] = useState<ProveSuccessResult | null>(null);
  const [kyc, setKyc] = useState<OkxKycAttestedData | null>(null);
  const [kycWarning, setKycWarning] = useState("");
  const [error, setError] = useState("");
  const [diagnostic, setDiagnostic] = useState<ProofDiagnostic | null>(null);
  const [includeKyc, setIncludeKyc] = useState(true);
  const [includeWallet, setIncludeWallet] = useState(false);
  const [shareMessage, setShareMessage] = useState("");
  const [sharedPassport, setSharedPassport] = useState<ShareablePassport | null>(null);

  const selectedProperty = useMemo(
    () => properties.find((item) => item.identityPropertyId === selectedPropertyId),
    [properties, selectedPropertyId]
  );

  useEffect(() => {
    const fromUrl = readPassportFromUrl();
    if (fromUrl) setSharedPassport(fromUrl);
  }, []);

  async function connectWallet() {
    setError("");
    const ethereum = getEthereum();
    if (!ethereum) {
      setError("MetaMask was not detected. Install MetaMask or use a browser with an injected EVM wallet.");
      return;
    }
    try {
      const accounts = await ethereum.request({ method: "eth_requestAccounts" });
      if (!Array.isArray(accounts) || typeof accounts[0] !== "string" || !accounts[0]) {
        throw new Error("Your wallet did not return an account.");
      }
      setWalletAddress(accounts[0]);
    } catch (walletError) {
      setError(formatError(walletError));
    }
  }

  async function loadOkxProperties() {
    setError("");
    setShareMessage("");
    setLoadingProperties(true);
    try {
      const client = new BnbZkIdClient();
      const initialized = await client.init({ appId: APP_ID });
      const rows = discoverOkxProperties(initialized.providers);
      if (rows.length === 0) {
        throw new Error("Primus did not return an enabled OKX KYC identity property for this App ID. No fallback or guessed property will be used.");
      }
      setProperties(rows);
      setSelectedPropertyId((current) =>
        rows.some((row) => row.identityPropertyId === current)
          ? current
          : rows[0].identityPropertyId
      );
    } catch (loadError) {
      setProperties([]);
      setSelectedPropertyId("");
      setError(formatError(loadError));
    } finally {
      setLoadingProperties(false);
    }
  }

  async function runOkxProof() {
    if (!walletAddress) {
      setError("Connect your EVM wallet before starting the Primus OKX proof.");
      return;
    }
    if (!selectedProperty) {
      setError("Load the live Primus OKX property before starting verification.");
      return;
    }

    setError("");
    setShareMessage("");
    setKycWarning("");
    setProof(null);
    setKyc(null);
    setRunning(true);
    setStatus("initializing");

    const clientRequestId = "primus-okx-kyc-" + Date.now();
    setDiagnostic({
      clientRequestId,
      providerId: selectedProperty.providerId,
      identityPropertyId: selectedProperty.identityPropertyId,
      progress: ["initializing"]
    });

    try {
      const client = new BnbZkIdClient();
      const initialized = await client.init({ appId: APP_ID });
      const liveSelection = discoverOkxProperties(initialized.providers).find(
        (row) => row.identityPropertyId === selectedProperty.identityPropertyId
      );
      if (!liveSelection) {
        throw new Error("The selected OKX property is no longer enabled in Primus Gateway configuration. Reload properties and try again.");
      }

      // Capture only the Gateway response metadata. Never read or store the zkTLS proof payload.
      const restoreGatewayCapture = captureGatewayProofResponse((gatewayResponse) => {
        setDiagnostic((current) => current ? { ...current, gatewayResponse } : current);
      });

      let result: ProveSuccessResult;
      try {
        // The official Primus demo's normal OKX flow does not pass jumpToUrl.
        result = await client.prove(
          {
            clientRequestId,
            userAddress: walletAddress,
            identityPropertyId: liveSelection.identityPropertyId
          },
          {
            onProgress(event) {
              setStatus(event.status as ProgressStatus);
              setDiagnostic((current) => {
                if (!current) return current;
                const last = current.progress[current.progress.length - 1];
                return {
                  ...current,
                  progress: last === event.status
                    ? current.progress
                    : [...current.progress, event.status],
                  proofRequestId: event.proofRequestId || current.proofRequestId
                };
              });
            }
          }
        );
      } finally {
        restoreGatewayCapture();
      }

      if (result.status !== "on_chain_attested") {
        throw new Error("Primus did not return an on-chain attested OKX result.");
      }
      setProof(result);
      setStatus("on_chain_attested");

      try {
        const decodedKyc = await readOkxAttestedKyc(result as PrimusAttestedResult);
        setKyc(decodedKyc);
      } catch (readError) {
        setKycWarning(
          "Primus attested the OKX property, but the app could not read or decode its KYC level from the testnet registry: " +
          formatError(readError)
        );
      }
    } catch (proofError) {
      setStatus("failed");
      setProof(null);
      setKyc(null);
      setError(formatError(proofError));
      setDiagnostic((current) => {
        if (!current) return current;
        const sdkError = proofError instanceof BnbZkIdProveError ? proofError : null;
        return {
          ...current,
          errorCode: sdkError?.code,
          sdkClientRequestId: sdkError?.clientRequestId,
          proofRequestId: sdkError?.proofRequestId || current.proofRequestId
        };
      });
    } finally {
      setRunning(false);
    }
  }

  async function shareKycCredential() {
    if (!proof || proof.status !== "on_chain_attested") return;
    if (!proof.proofRequestId) {
      setError("Primus did not return a proof request ID. This result cannot be independently checked, so a shareable credential was not created.");
      return;
    }

    const passport: ShareablePassport = {
      version: 1,
      issuer: "Primus BNB ZKID",
      title: "OKX KYC Credential",
      status: "on_chain_attested",
      issuedAt: new Date().toISOString(),
      providerId: proof.providerId,
      identityPropertyId: proof.identityPropertyId,
      proofRequestId: proof.proofRequestId,
      ...(includeWallet ? { walletAddress: proof.walletAddress } : {}),
      ...(includeKyc && kyc ? { kyc } : {})
    };

    try {
      await navigator.clipboard.writeText(makePassportUrl(passport));
      setShareMessage("OKX credential link copied. Recipients must check the proof with Primus before relying on its claims.");
    } catch {
      setError("Clipboard access failed. Open this application over HTTPS and try again.");
    }
  }

  if (sharedPassport) {
    return <SharedKycView passport={sharedPassport} />;
  }

  return (
    <main className="page-shell">
      <header className="topbar">
        <a className="brand" href="/">
          <span className="brand-mark">P</span>
          <span>PRIMUS <b>OKX KYC</b></span>
        </a>
        <span className="network-pill"><i /> ZK ID · OKX</span>
      </header>

      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow"><span className="eyebrow-line" /> OKX ACCOUNT VERIFICATION</p>
          <h1>Your KYC status.<br /><span>Proven with Primus.</span></h1>
          <p className="hero-subtitle">
            Create a verifiable OKX KYC credential using Primus zkTLS and BNB ZKID. The app displays the KYC level only after an on-chain attestation and a matching testnet registry read.
          </p>
          <div className="hero-points">
            <span><b>✓</b> Primus proof only</span>
            <span><b>✓</b> KYC-level display</span>
            <span><b>✓</b> Shareable proof reference</span>
          </div>
        </div>
        <div className="hero-art" aria-hidden="true">
          <div className="art-ring art-ring-one" />
          <div className="art-ring art-ring-two" />
          <div className="art-card">
            <span className="art-spark">✳</span>
            <span className="art-card-label">OKX KYC CREDENTIAL</span>
            <div className="art-avatar">OKX</div>
            <div className="art-lines"><i /><i /><i /></div>
            <div className="art-proof"><span>✓</span> PRIMUS VERIFIED</div>
          </div>
          <span className="float-chip chip-one">zkTLS</span>
          <span className="float-chip chip-two">ZK ID</span>
        </div>
      </section>

      <section className="workspace">
        <div className="section-heading">
          <div><p className="eyebrow">START HERE</p><h2>Verify your OKX account</h2></div>
          <span className="step-count">01 / 03</span>
        </div>

        <div className="flow-grid">
          <article className="panel setup-panel">
            <div className="panel-top">
              <span className="panel-icon">01</span>
              <div><h3>Connect your identity</h3><p>Connect a wallet address for the BNB ZKID proof request.</p></div>
            </div>
            {walletAddress ? (
              <div className="connected-wallet">
                <span className="online-dot" />
                <div><b>Wallet connected</b><small>{shortAddress(walletAddress)}</small></div>
                <button className="text-button" onClick={() => setWalletAddress("")}>Disconnect</button>
              </div>
            ) : (
              <button className="button button-secondary full-button" onClick={connectWallet}>Connect MetaMask <span>↗</span></button>
            )}
            <div className="hint-box">No seed phrase or private key is requested. The wallet address is used as the identity reference for Primus.</div>
          </article>

          <article className="panel setup-panel">
            <div className="panel-top">
              <span className="panel-icon">02</span>
              <div><h3>Load Primus OKX property</h3><p>Read the live OKX identity property enabled for this app.</p></div>
            </div>
            <button className="button button-secondary full-button" onClick={loadOkxProperties} disabled={loadingProperties || running}>
              {loadingProperties ? <><span className="spinner" /> Loading OKX property</> : "Discover OKX KYC property"}
            </button>
            {properties.length > 0 ? (
              <div className="property-selector">
                <label htmlFor="property">Primus OKX identity property</label>
                <select id="property" value={selectedPropertyId} onChange={(event) => setSelectedPropertyId(event.target.value)}>
                  {properties.map((property) => (
                    <option key={property.identityPropertyId} value={property.identityPropertyId}>
                      {property.description}
                    </option>
                  ))}
                </select>
                <small>Source: live Primus Gateway configuration</small>
              </div>
            ) : (
              <div className="hint-box">The OKX property appears here only when the configured Primus App ID exposes it.</div>
            )}
          </article>
        </div>

        <article className="panel prove-panel">
          <div className="prove-head">
            <div className="panel-top">
              <span className="panel-icon panel-icon-bright">03</span>
              <div><h3>Generate your OKX KYC proof</h3><p>Sign in to OKX in this browser, enable the Primus extension, then run verification.</p></div>
            </div>
            <a className="extension-link" href={PRIMUS_EXTENSION_URL} target="_blank" rel="noreferrer">Primus extension ↗</a>
          </div>
          <div className="proof-warning">
            <span>i</span>
            <p>Complete sign-in only on the OKX page opened by Primus. Never enter your OKX password, API key, secret or verification code into this application.</p>
          </div>
          <div className="hint-box">
            <b>Disclosure boundary:</b> Primus currently publishes one combined OKX identity property containing KYC level and six-month trade-history data. This app displays and shares only the KYC level. It is not a separate KYC-only proof template.
          </div>
          <button className="button button-primary full-button" onClick={runOkxProof} disabled={running || !walletAddress || !selectedProperty}>
            {running ? <><span className="spinner spinner-dark" /> Verifying with Primus</> : "Verify OKX KYC with Primus"}
            {!running && <span>→</span>}
          </button>
          <div className="status-block">
            <div className="status-top"><span className="status-indicator" data-status={status} /> <b>{statusLabel(status)}</b>{running && <span className="status-live">LIVE</span>}</div>
            <div className="progress-track"><i data-status={status} /></div>
            <div className="status-steps">
              <span className={["initializing","data_verifying","proof_generating","on_chain_attested"].includes(status) ? "active" : ""}>Initialize</span>
              <span className={["data_verifying","proof_generating","on_chain_attested"].includes(status) ? "active" : ""}>zkTLS verify</span>
              <span className={["proof_generating","on_chain_attested"].includes(status) ? "active" : ""}>ZK proof</span>
              <span className={status === "on_chain_attested" ? "active" : ""}>Attested</span>
            </div>
          </div>
        </article>

        {error && <div className="alert alert-error"><b>Could not continue</b><span>{error}</span></div>}
        {error && diagnostic && (
          <div className="hint-box">
            <b>Primus diagnostic details</b>
            <small>Progress reached: {diagnostic.progress.join(" → ")}</small>
            <small>Provider ID: {diagnostic.providerId}</small>
            <small>Identity property ID: {diagnostic.identityPropertyId}</small>
            <small>Client request ID: {diagnostic.sdkClientRequestId || diagnostic.clientRequestId}</small>
            {diagnostic.errorCode && <small>SDK error code: {diagnostic.errorCode}</small>}
            {diagnostic.proofRequestId && <small>Proof request ID: {diagnostic.proofRequestId}</small>}
            {diagnostic.gatewayResponse && (
              <>
                <small>Gateway HTTP status: {diagnostic.gatewayResponse.httpStatus}</small>
                {diagnostic.gatewayResponse.responseStatus && <small>Gateway status: {diagnostic.gatewayResponse.responseStatus}</small>}
                {diagnostic.gatewayResponse.errorCategory && <small>Gateway error category: {diagnostic.gatewayResponse.errorCategory}</small>}
                {diagnostic.gatewayResponse.errorCode && <small>Gateway error code: {diagnostic.gatewayResponse.errorCode}</small>}
                {diagnostic.gatewayResponse.errorMessage && <small>Gateway message: {diagnostic.gatewayResponse.errorMessage}</small>}
                {diagnostic.gatewayResponse.proofRequestId && <small>Gateway proof request ID: {diagnostic.gatewayResponse.proofRequestId}</small>}
              </>
            )}
          </div>
        )}

        {proof && proof.status === "on_chain_attested" && (
          <section className="result-section">
            <div className="section-heading">
              <div><p className="eyebrow">PROOF COMPLETE</p><h2>Your OKX KYC credential</h2></div>
              <span className="verified-tag large-tag">✓ PRIMUS ATTESTED</span>
            </div>
            <article className="panel result-panel">
              <div className="result-summary">
                <div className="result-icon">✓</div>
                <div><h3>OKX identity proof</h3><p>Primus returned on-chain attestation for the OKX identity property.</p></div>
              </div>
              <div className="result-data">
                <div><small>PROPERTY</small><b>{proof.identityPropertyId}</b></div>
                <div><small>PROVIDER</small><b>{proof.providerId}</b></div>
                <div><small>PROOF REQUEST</small><b>{proof.proofRequestId || "Not returned"}</b></div>
                <div><small>WALLET</small><b>{shortAddress(proof.walletAddress)}</b></div>
              </div>
              {kyc ? (
                <div className="decoded-profile">
                  <p className="eyebrow">KYC LEVEL · PRIMUS REGISTRY DATA</p>
                  <div className="profile-stats">
                    <div><small>OKX KYC LEVEL</small><strong>{kyc.kycLevel}</strong></div>
                  </div>
                  <small className="registry-note">BNB Smart Chain testnet · registry timestamp {kyc.registryTimestamp}</small>
                </div>
              ) : (
                <div className="hint-box">{kycWarning || "Primus attested the OKX property. The KYC level has not yet been decoded."}</div>
              )}
              <div className="share-controls">
                <p className="eyebrow">SELECTIVE SHARING</p>
                <label className="check-row">
                  <input type="checkbox" checked={includeKyc} onChange={(event) => setIncludeKyc(event.target.checked)} disabled={!kyc} />
                  <span><b>Include KYC level only</b><small>No trade-history figure is included in the shared page.</small></span>
                </label>
                <label className="check-row">
                  <input type="checkbox" checked={includeWallet} onChange={(event) => setIncludeWallet(event.target.checked)} />
                  <span><b>Include wallet address</b><small>Off by default; wallet addresses may be publicly linkable.</small></span>
                </label>
                <button className="button button-primary full-button" onClick={shareKycCredential} disabled={!proof.proofRequestId}>Copy shareable OKX KYC credential <span>↗</span></button>
                {!proof.proofRequestId && <p className="share-warning">Primus did not return a proof reference, so independent sharing is disabled.</p>}
                {shareMessage && <p className="share-success">{shareMessage}</p>}
              </div>
              <p className="fine-print">
                Only the KYC level is displayed and placed in the share link. The Primus identity property itself remains the published composite KYC + six-month trade-history property.
              </p>
            </article>
          </section>
        )}
      </section>

      <footer className="footer">
        <div className="brand"><span className="brand-mark">P</span><span>PRIMUS <b>OKX KYC</b></span></div>
        <p>Proof first. KYC claim second.</p>
        <small>Development build · BNB ZKID demo registry</small>
      </footer>
    </main>
  );
}
