import { PrimusZKTLS } from "@primuslabs/zktls-js-sdk";

type HeaderValue = string | string[] | undefined;
type ApiRequest = {
  method?: string;
  headers: Record<string, HeaderValue>;
  body?: unknown;
  socket?: { remoteAddress?: string };
};
type ApiResponse = {
  setHeader(name: string, value: string): void;
  status(code: number): ApiResponse;
  json(value: unknown): void;
};

type SignRequest = { signParams?: unknown };
type AttestationRequest = {
  appId?: unknown;
  attTemplateID?: unknown;
  userAddress?: unknown;
  timestamp?: unknown;
  requestid?: unknown;
};

const MAX_REQUEST_CHARS = 24_000;
const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 12;
const requestCounters = new Map<string, { count: number; resetAt: number }>();
let primusClientPromise: Promise<PrimusZKTLS> | undefined;

function header(value: HeaderValue): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function reply(res: ApiResponse, status: number, body: Record<string, unknown>) {
  res.status(status).json(body);
}

function getClient(): Promise<PrimusZKTLS> {
  if (!primusClientPromise) {
    const appId = process.env.PRIMUS_APP_ID?.trim();
    const appSecret = process.env.PRIMUS_APP_SECRET?.trim();
    if (!appId || !appSecret) {
      throw new Error("Server Primus credentials are not configured.");
    }
    const client = new PrimusZKTLS();
    primusClientPromise = client.init(appId, appSecret).then(() => client).catch((error) => {
      primusClientPromise = undefined;
      throw error;
    });
  }
  return primusClientPromise;
}

function isSameOrigin(req: ApiRequest): boolean {
  const origin = header(req.headers.origin);
  const host = header(req.headers["x-forwarded-host"]) || header(req.headers.host);
  if (!origin || !host) return false;
  try {
    return new URL(origin).host.toLowerCase() === host.split(",")[0].trim().toLowerCase();
  } catch {
    return false;
  }
}

function allowRateLimit(req: ApiRequest): boolean {
  const forwardedFor = header(req.headers["x-forwarded-for"]);
  const ip = forwardedFor.split(",")[0].trim() || req.socket?.remoteAddress || "unknown";
  const now = Date.now();
  const current = requestCounters.get(ip);
  if (!current || current.resetAt <= now) {
    requestCounters.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  if (current.count >= MAX_REQUESTS_PER_WINDOW) return false;
  current.count += 1;
  return true;
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return reply(res, 405, { error: "Use POST for signing requests." });
  }
  if (!isSameOrigin(req)) {
    return reply(res, 403, { error: "This signing endpoint only accepts same-origin requests." });
  }
  if (!allowRateLimit(req)) {
    return reply(res, 429, { error: "Too many signing attempts. Please wait and try again." });
  }

  let body: SignRequest;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) as SignRequest : req.body as SignRequest;
  } catch {
    return reply(res, 400, { error: "The request body must be valid JSON." });
  }

  const signParams = body?.signParams;
  if (typeof signParams !== "string" || signParams.length === 0 || signParams.length > MAX_REQUEST_CHARS) {
    return reply(res, 400, { error: "A valid, size-limited signParams string is required." });
  }

  const appId = process.env.PRIMUS_APP_ID?.trim();
  const templateId = process.env.PRIMUS_TEMPLATE_ID?.trim();
  if (!appId || !process.env.PRIMUS_APP_SECRET?.trim() || !templateId) {
    return reply(res, 503, { error: "Primus server configuration is incomplete." });
  }

  let attRequest: AttestationRequest;
  try {
    const parsed: unknown = JSON.parse(signParams);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return reply(res, 400, { error: "The attestation request must be a JSON object." });
    }
    attRequest = parsed as AttestationRequest;
  } catch {
    return reply(res, 400, { error: "signParams must contain valid JSON." });
  }

  if (attRequest.appId !== appId || attRequest.attTemplateID !== templateId) {
    return reply(res, 400, { error: "The request App ID or Template ID does not match this server configuration." });
  }
  if (typeof attRequest.userAddress !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(attRequest.userAddress)) {
    return reply(res, 400, { error: "A valid EVM wallet address is required." });
  }
  if (typeof attRequest.timestamp !== "number" || Math.abs(Date.now() - attRequest.timestamp) > 5 * 60_000) {
    return reply(res, 400, { error: "The attestation request timestamp is missing or expired. Refresh and try again." });
  }
  if (typeof attRequest.requestid !== "string" || attRequest.requestid.length < 8 || attRequest.requestid.length > 128) {
    return reply(res, 400, { error: "The request ID is missing or invalid." });
  }

  try {
    const client = await getClient();
    const signResult = await client.sign(signParams);
    return reply(res, 200, { signResult });
  } catch {
    // Do not return SDK internals or credential material to the browser.
    return reply(res, 500, { error: "Primus could not sign this request. Check the server credentials and template configuration." });
  }
}
