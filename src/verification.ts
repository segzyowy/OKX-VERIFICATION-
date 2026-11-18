import {
  createPublicClient,
  decodeAbiParameters,
  getAddress,
  hexToString,
  http,
  isHex,
  keccak256,
  toBytes,
  type Address,
  type Hex
} from "viem";
import { bscTestnet } from "viem/chains";

const OKX_IDENTITY_PROPERTY_HEX =
  "0x289d4fed0b3ecb26e711e6d1200b46f1d67f2da4847b03f99aa8584706933195" as Hex;
const IDENTITY_PROPERTY_BY_GATEWAY_ID: Record<string, Hex> = {
  okx_trade_kyc: OKX_IDENTITY_PROPERTY_HEX
};
const BNB_TESTNET_IDENTITY_REGISTRY =
  "0x9569299A8877Bc155232cF5Aa50AF42F9Fc32C7C" as Address;

const REGISTRY_ABI = [
  {
    type: "function",
    name: "getLatestIdentityProperty",
    stateMutability: "view",
    inputs: [
      { name: "wallet", type: "address" },
      { name: "providerId", type: "bytes32" },
      { name: "identityProperty", type: "bytes32" }
    ],
    outputs: [
      { name: "timestamp", type: "uint64" },
      { name: "dataBlob", type: "bytes" }
    ]
  }
] as const;

export type PrimusAttestedResult = {
  status: "on_chain_attested";
  walletAddress: string;
  providerId: string;
  identityPropertyId: string;
  proofRequestId?: string;
};

export type OkxKycAttestedData = {
  /** KYC level decoded from the Primus registry payload. */
  kycLevel: string;
  registryTimestamp: string;
  registry: string;
  chainId: number;
};

export function identityPropertyToBytes32(identityPropertyId: string): Hex {
  const key = identityPropertyId.trim();
  if (isHex(key, { strict: true }) && key.length === 66) {
    if (key.toLowerCase() === OKX_IDENTITY_PROPERTY_HEX) {
      return OKX_IDENTITY_PROPERTY_HEX;
    }
    throw new Error("Primus returned an OKX property without a reviewed KYC decoder. No KYC level will be inferred.");
  }
  const mapped = IDENTITY_PROPERTY_BY_GATEWAY_ID[key.toLowerCase()];
  if (!mapped) {
    throw new Error("Primus returned an identity property that this app does not decode as OKX KYC.");
  }
  return mapped;
}

export function providerIdToBytes32(providerId: string): Hex {
  const value = providerId.trim();
  if (isHex(value, { strict: true }) && value.length === 66) {
    return value.toLowerCase() as Hex;
  }
  if (!value) {
    throw new Error("The Primus result did not include a provider ID.");
  }
  return keccak256(toBytes(value));
}

function decodeOkxKycLevel(dataBlob: Hex): string {
  const text = hexToString(dataBlob).trim();
  if (text.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        let record = parsed as Record<string, unknown>;
        if (record.data !== null && typeof record.data === "object" && !Array.isArray(record.data)) {
          record = record.data as Record<string, unknown>;
        }
        if (typeof record.kycLevel === "string" && record.kycLevel.trim() !== "") {
          return record.kycLevel.trim();
        }
      }
    } catch {
      // Fall through to the documented ABI tuple decoder.
    }
  }

  // Primus's official OKX schema is a tuple of (kycLevel, tradeHistoryLast6Months).
  // The UI discloses only kycLevel, but the underlying attested property is bundled.
  const [profile] = decodeAbiParameters(
    [{
      type: "tuple",
      components: [
        { name: "kycLevel", type: "string" },
        { name: "tradeHistoryLast6Months", type: "uint256" }
      ]
    }],
    dataBlob
  );
  if (typeof profile.kycLevel !== "string" || profile.kycLevel.trim() === "") {
    throw new Error("The Primus OKX payload did not contain a readable KYC level.");
  }
  return profile.kycLevel.trim();
}

/**
 * Reads the OKX property from the published BNB Smart Chain testnet demo registry.
 * The decoded UI/share claim is KYC level only; Primus's source property also bundles
 * six-month trade-history data. This is not a separate KYC-only cryptographic property.
 */
export async function readOkxAttestedKyc(
  proof: PrimusAttestedResult
): Promise<OkxKycAttestedData> {
  if (proof.status !== "on_chain_attested") {
    throw new Error("OKX KYC data can only be read after Primus reports on-chain attestation.");
  }

  const identityProperty = identityPropertyToBytes32(proof.identityPropertyId);
  const providerId = providerIdToBytes32(proof.providerId);
  const rpcUrl =
    import.meta.env.VITE_BNB_TESTNET_RPC_URL?.trim() ||
    "https://bsc-testnet.publicnode.com";

  const client = createPublicClient({
    chain: bscTestnet,
    transport: http(rpcUrl)
  });
  const [timestamp, dataBlob] = await client.readContract({
    address: BNB_TESTNET_IDENTITY_REGISTRY,
    abi: REGISTRY_ABI,
    functionName: "getLatestIdentityProperty",
    args: [getAddress(proof.walletAddress) as Address, providerId, identityProperty]
  });

  if (!dataBlob || dataBlob === "0x") {
    throw new Error("Primus attested successfully, but no OKX identity payload was found in the BNB testnet demo registry.");
  }

  return {
    kycLevel: decodeOkxKycLevel(dataBlob as Hex),
    registryTimestamp: timestamp.toString(),
    registry: BNB_TESTNET_IDENTITY_REGISTRY,
    chainId: bscTestnet.id
  };
}

export type ShareablePassport = {
  version: 1;
  issuer: "Primus BNB ZKID";
  title: "OKX KYC Credential";
  status: "on_chain_attested";
  issuedAt: string;
  proofRequestId: string;
  providerId: string;
  identityPropertyId: string;
  walletAddress?: string;
  kyc?: OkxKycAttestedData;
};

function encodeBase64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary);
}

function decodeBase64Utf8(value: string): string {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function makePassportUrl(passport: ShareablePassport): string {
  const encoded = encodeBase64Utf8(JSON.stringify(passport));
  const url = new URL(window.location.href);
  url.hash = "passport=" + encoded;
  return url.toString();
}

export function readPassportFromUrl(): ShareablePassport | null {
  const hash = window.location.hash;
  if (!hash.startsWith("#passport=")) return null;
  try {
    const parsed: unknown = JSON.parse(decodeBase64Utf8(hash.slice("#passport=".length)));
    if (parsed === null || typeof parsed !== "object") return null;
    const value = parsed as Partial<ShareablePassport>;
    if (
      value.version !== 1 ||
      value.issuer !== "Primus BNB ZKID" ||
      value.status !== "on_chain_attested" ||
      value.title !== "OKX KYC Credential" ||
      typeof value.proofRequestId !== "string" ||
      value.proofRequestId.trim().length === 0 ||
      typeof value.providerId !== "string" ||
      typeof value.identityPropertyId !== "string"
    ) return null;
    return value as ShareablePassport;
  } catch {
    return null;
  }
}
