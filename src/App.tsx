import { useEffect, useState } from "react";
import { PrimusZKTLS } from "@primuslabs/zktls-js-sdk";

const APP_ID = import.meta.env.VITE_PRIMUS_APP_ID?.trim() ?? "";
const TEMPLATE_ID = import.meta.env.VITE_PRIMUS_TEMPLATE_ID?.trim() ?? "";
const PRIMUS_EXTENSION_URL = "https://chromewebstore.google.com/detail/primus/oeiomhmbaapihbilkfkhmlajkeegnjhe";

type EthereumProvider = {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: "accountsChanged", callback: (accounts: string[]) => void): void;
  removeListener?(event: "accountsChanged", callback: (accounts: string[]) => void): void;
};

declare global {
  interface Window {
    ethereum?: EthereumProvider;
  }
}

type Result = { recipient: string; timestamp: number; data: unknown };
type Readiness = "checking" | "ready" | "missing-config" | "missing-extension" | "error";

let primusPromise: Promise<PrimusZKTLS> | null = null;

function getPrimusClient(): Promise<PrimusZKTLS> {
  if (!APP_ID) return Promise.reject(new Error("Add VITE_PRIMUS_APP_ID to your deployment environment variables."));
  if (!primusPromise) {
    const client = new PrimusZKTLS();
    primusPromise = client.init(APP_ID).then(() => client).catch((error) => {
      primusPromise = null;
      throw error;
    });
  }
  return primusPromise;
}

function readableError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("00006") || message.toLowerCase().includes("extension")) {
    return "The Primus browser extension is not available. Install or enable it, then reload this page.";
  }
  return message || "An unexpected error occurred.";
}

function isEvmAddress(value: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(value.trim());
}

function shortAddress(value: string): string {
  return value ? value.slice(0, 6) + "…" + value.slice(-4) : "";
}

function timestampLabel(value: number): string {
  const millis = value > 1_000_000_000_000 ? value : value * 1000;
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

export default function App() {
  const [walletAddress, setWalletAddress] = useState("");
  const [manualAddress, setManualAddress] = useState("");
  const [readiness, setReadiness] = useState<Readiness>("checking");
  const [readinessMessage, setReadinessMessage] = useState("Checking Primus configuration and extension…");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let active = true;
    if (!APP_ID || !TEMPLATE_ID) {
      setReadiness("missing-config");
      setReadinessMessage("Add the public App ID and your real Primus Template ID in Vercel.");
    } else {
      void getPrimusClient().then(() => {
        if (active) {
          setReadiness("ready");
          setReadinessMessage("Primus is ready. The browser extension is connected.");
        }
      }).catch((cause) => {
        if (active) {
          const message = readableError(cause);
          setReadiness(message.includes("extension") ? "missing-extension" : "error");
          setReadinessMessage(message);
        }
      });
    }

    const provider = window.ethereum;
    const onAccountsChanged = (accounts: string[]) => setWalletAddress(accounts?.[0] ?? "");
    provider?.on?.("accountsChanged", onAccountsChanged);
    return () => {
      active = false;
      provider?.removeListener?.("accountsChanged", onAccountsChanged);
    };
  }, []);

  async function retryInitialization() {
    setReadiness("checking");
    setReadinessMessage("Connecting to the Primus extension…");
    try {
      await getPrimusClient();
      setReadiness("ready");
      setReadinessMessage("Primus is ready. The browser extension is connected.");
    } catch (cause) {
      const message = readableError(cause);
      setReadiness(message.includes("extension") ? "missing-extension" : "error");
      setReadinessMessage(message);
    }
  }

  async function connectWallet() {
    setError("");
    const provider = window.ethereum;
    if (!provider) {
      setError("MetaMask was not detected. You can paste an EVM wallet address below instead.");
      return;
    }
    try {
      const accounts = await provider.request({ method: "eth_requestAccounts" });
      const first = Array.isArray(accounts) ? accounts[0] : "";
      if (typeof first !== "string" || !isEvmAddress(first)) throw new Error("MetaMask did not return a valid EVM address.");
      setWalletAddress(first);
      setManualAddress(first);
    } catch (cause) {
      setError(readableError(cause));
    }
  }

  function useManualAddress() {
    const value = manualAddress.trim();
    if (!isEvmAddress(value)) {
      setError("Enter a valid EVM address beginning with 0x and containing 40 hexadecimal characters.");
      return;
    }
    setError("");
    setWalletAddress(value);
  }

  async function generateAttestation() {
    setError("");
    setResult(null);
    setCopied(false);

    if (!walletAddress || !isEvmAddress(walletAddress)) {
      setError("Connect MetaMask or enter a valid EVM wallet address first.");
      return;
    }
    if (!APP_ID || !TEMPLATE_ID) {
      setError("The Primus App ID or Template ID is missing. Configure both in Vercel before generating an attestation.");
      return;
    }

    setBusy(true);
    try {
      const client = await getPrimusClient();
      const request = client.generateRequestParams(TEMPLATE_ID, walletAddress);
      request.setAttMode({ algorithmType: "proxytls" });
      const requestStr = request.toJsonString();

      const response = await fetch("/api/primus/sign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signParams: requestStr })
      });
      const payload: unknown = await response.json().catch(() => null);
      const responseData = payload && typeof payload === "object"
        ? payload as { signResult?: unknown; error?: unknown }
        : {};

      if (!response.ok) {
        throw new Error(typeof responseData.error === "string" ? responseData.error : "The signing service rejected the request.");
      }
      if (typeof responseData.signResult !== "string" || !responseData.signResult) {
        throw new Error("The signing service did not return a signed request.");
      }

      const attestation = await client.startAttestation(responseData.signResult);
      if (!client.verifyAttestation(attestation)) {
        throw new Error("Primus returned an attestation whose signature could not be verified.");
      }
      if (typeof attestation.recipient !== "string" ||
          attestation.recipient.toLowerCase() !== walletAddress.toLowerCase()) {
        throw new Error("The attestation recipient does not match the connected wallet address.");
      }

      let data: unknown = attestation.data;
      if (typeof attestation.data === "string") {
        try {
          data = JSON.parse(attestation.data) as unknown;
        } catch {
          data = attestation.data;
        }
      }
      setResult({ recipient: attestation.recipient, timestamp: attestation.timestamp, data });
      setReadiness("ready");
      setReadinessMessage("The Primus attestation signature is valid.");
    } catch (cause) {
      setError(readableError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function copyResult() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(result, null, 2));
      setCopied(true);
    } catch {
      setError("Clipboard access was blocked. Copy the result directly from the displayed data.");
    }
  }

  const dataText = result ? JSON.stringify(result.data, null, 2) : "";

  return (
    <main className="app-shell">
      <nav className="topbar">
        <a className="brand" href="/">
          <span className="brand-mark">P</span>
          <span>PRIMUS <b>OKX VERIFY</b></span>
        </a>
        <a className="docs-link" href="https://docs.primuslabs.xyz/enterprise/zk-tls-sdk/overview" target="_blank" rel="noreferrer">
          Primus docs <span>↗</span>
        </a>
      </nav>

      <section className="hero">
        <div className="hero-copy">
          <div className="eyebrow"><span className="eyebrow-dot" /> PRIVATE DATA · PUBLIC PROOF</div>
          <h1>Prove your OKX data.<br /><em>Keep control of it.</em></h1>
          <p className="hero-description">
            Generate a Primus zkTLS attestation from an approved OKX data template, then verify the attestor signature before reviewing the returned fields.
          </p>
          <div className="hero-chips">
            <span><i>✓</i> Primus zkTLS</span>
            <span><i>✓</i> Server-side signing</span>
            <span><i>✓</i> No BNB ZK ID</span>
          </div>
        </div>
        <div className="hero-visual" aria-hidden="true">
          <div className="visual-orbit orbit-a" />
          <div className="visual-orbit orbit-b" />
          <div className="proof-card">
            <div className="proof-card-top"><span className="proof-icon">✳</span><span>ATTESTATION / 001</span></div>
            <div className="proof-card-title">OKX DATA<br /><strong>VERIFICATION</strong></div>
            <div className="proof-card-rule" />
            <div className="proof-card-bottom"><span className="proof-check">✓</span><span>PRIMUS SIGNATURE</span><b>VALID</b></div>
          </div>
          <span className="orbit-tag tag-top">zkTLS</span>
          <span className="orbit-tag tag-bottom">0 data uploaded</span>
        </div>
      </section>

      <section className="content">
        <div className="section-heading">
          <div><span className="eyebrow">GET STARTED</span><h2>Create your attestation</h2></div>
          <span className="step-indicator">01 <i>/</i> 03</span>
        </div>

        <div className="setup-grid">
          <article className="surface setup-card">
            <div className="card-number">01</div>
            <div className="card-heading"><h3>Identify your wallet</h3><p>Your address is used as the attestation recipient. No wallet signature or transaction is requested.</p></div>
            {walletAddress ? (
              <div className="wallet-connected">
                <span className="live-dot" />
                <div><b>Wallet address selected</b><small>{shortAddress(walletAddress)}</small></div>
                <button className="text-action" onClick={() => setWalletAddress("")}>Clear</button>
              </div>
            ) : (
              <>
                <button className="button button-outline" onClick={connectWallet}>Connect MetaMask <span>↗</span></button>
                <div className="field-divider"><span>or enter an address</span></div>
                <div className="manual-row">
                  <input aria-label="EVM wallet address" value={manualAddress} onChange={(event) => setManualAddress(event.target.value)} placeholder="0x…" spellCheck={false} />
                  <button className="button button-dark" onClick={useManualAddress}>Use address</button>
                </div>
              </>
            )}
          </article>

          <article className="surface setup-card">
            <div className="card-number">02</div>
            <div className="card-heading"><h3>Connect to Primus</h3><p>The browser extension runs the source verification flow. Your App Secret remains on the server.</p></div>
            <div className={"readiness-panel " + readiness}>
              <span className="readiness-symbol">{readiness === "ready" ? "✓" : readiness === "checking" ? "…" : "!"}</span>
              <div><b>{readiness === "ready" ? "Primus is ready" : readiness === "checking" ? "Connecting" : "Action required"}</b><small>{readinessMessage}</small></div>
            </div>
            {readiness !== "ready" && (
              <div className="readiness-actions">
                <a href={PRIMUS_EXTENSION_URL} target="_blank" rel="noreferrer">Install Primus extension ↗</a>
                <button className="text-action" onClick={retryInitialization}>Retry</button>
              </div>
            )}
          </article>
        </div>

        <article className="surface attestation-panel">
          <div className="attestation-header">
            <div><div className="card-number">03</div><h3>Generate and verify</h3><p>Primus signs the request on the server, performs zkTLS in the browser, and returns a signed attestation.</p></div>
            <span className="template-pill">TEMPLATE {TEMPLATE_ID ? "CONFIGURED" : "NOT SET"}</span>
          </div>
          <div className="template-summary">
            <span className="template-icon">ID</span>
            <div><b>Primus attestation template</b><small>{TEMPLATE_ID || "Set VITE_PRIMUS_TEMPLATE_ID after selecting the correct OKX template in Primus Developer Hub."}</small></div>
          </div>
          <button className="button button-primary" onClick={generateAttestation} disabled={busy || readiness !== "ready" || !walletAddress}>
            {busy ? <><span className="spinner" /> Working with Primus…</> : <>Generate zkTLS attestation <span>→</span></>}
          </button>
          <div className="security-note"><span>i</span><p>Only use a template you trust and have reviewed. Never enter an OKX password, API key, one-time code, cookie, or wallet private key into this app.</p></div>
        </article>

        {error && <div className="alert alert-error"><b>Could not complete verification</b><span>{error}</span></div>}

        {result && (
          <section className="result-section">
            <div className="result-heading">
              <div><span className="eyebrow">RESULT</span><h2>Attestation verified</h2></div>
              <span className="valid-pill"><i>✓</i> SIGNATURE VALID</span>
            </div>
            <article className="surface result-card">
              <div className="result-meta">
                <div><small>RECIPIENT</small><b>{shortAddress(result.recipient)}</b></div>
                <div><small>ATTESTED</small><b>{timestampLabel(result.timestamp)}</b></div>
                <div><small>TEMPLATE</small><b>{shortAddress(TEMPLATE_ID)}</b></div>
              </div>
              <div className="data-heading"><div><h3>Verified template data</h3><p>Parsed from the signed Primus attestation.</p></div><button className="copy-button" onClick={copyResult}>{copied ? "Copied ✓" : "Copy JSON"}</button></div>
              <pre className="data-output">{dataText}</pre>
              <p className="claim-boundary">
                <b>Important:</b> A valid Primus signature proves the attestation was signed by Primus. It does not by itself establish that this template proves OKX KYC. Confirm the template source, fields, and semantics in Primus Developer Hub before treating any field as a KYC result.
              </p>
            </article>
          </section>
        )}
      </section>

      <footer className="footer">
        <a className="brand" href="/"><span className="brand-mark">P</span><span>PRIMUS <b>OKX VERIFY</b></span></a>
        <span>Proof first. Claims only when supported.</span>
      </footer>
    </main>
  );
}
