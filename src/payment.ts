/**
 * x402 Payment Verification via CDP Facilitator
 *
 * Verifies X-Payment header against Coinbase CDP facilitator.
 * Uses Ed25519 JWT auth (EdDSA) matching CDP SDK format.
 */

const CDP_FACILITATOR = "https://api.cdp.coinbase.com/platform/v2/x402";

export interface PaymentRequirements {
  scheme: string;
  network: string;
  asset: string;
  payTo: string;
  amount: string;
  maxTimeoutSeconds: number;
}

export interface PaymentResult {
  valid: boolean;
  payer?: string;
  txHash?: string;
  error?: string;
}

// ── Base64url helpers ──

function b64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function textToB64url(text: string): string {
  return b64url(new TextEncoder().encode(text));
}

function hexFromBytes(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ── CDP Ed25519 JWT ──

async function importEd25519Key(base64Secret: string): Promise<CryptoKey> {
  const decoded = Uint8Array.from(atob(base64Secret), (c) => c.charCodeAt(0));
  if (decoded.length !== 64) {
    throw new Error(`Expected 64 bytes Ed25519 key, got ${decoded.length}`);
  }

  const seed = decoded.slice(0, 32);
  const pub = decoded.slice(32);

  const jwk = {
    kty: "OKP",
    crv: "Ed25519",
    d: b64url(seed),
    x: b64url(pub),
  };

  return crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, [
    "sign",
  ]);
}

async function createCdpJwt(
  keyId: string,
  privateKey: CryptoKey,
  method: string,
  url: string
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const nonce = hexFromBytes(crypto.getRandomValues(new Uint8Array(16)));

  // Parse URL for CDP URI format: "METHOD host/path"
  const parsed = new URL(url);
  const uri = `${method} ${parsed.host}${parsed.pathname}`;

  const header = { alg: "EdDSA", kid: keyId, typ: "JWT", nonce };
  const payload = {
    sub: keyId,
    iss: "cdp",
    aud: ["cdp_service"],
    nbf: now,
    iat: now,
    exp: now + 120,
    uris: [uri],
  };

  const headerB64 = textToB64url(JSON.stringify(header));
  const payloadB64 = textToB64url(JSON.stringify(payload));
  const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);

  const signature = await crypto.subtle.sign("Ed25519", privateKey, signingInput);

  return `${headerB64}.${payloadB64}.${b64url(new Uint8Array(signature))}`;
}

// ── Payment Verification ──

function decodePaymentHeader(header: string): Record<string, unknown> | null {
  try {
    return JSON.parse(atob(header));
  } catch {
    try {
      return JSON.parse(decodeURIComponent(escape(atob(header))));
    } catch {
      return null;
    }
  }
}

async function callFacilitator(
  endpoint: string,
  body: object,
  cdpKeyId: string,
  cdpKey: CryptoKey
): Promise<Response> {
  const url = `${CDP_FACILITATOR}/${endpoint}`;
  const jwt = await createCdpJwt(cdpKeyId, cdpKey, "POST", url);

  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify(body),
  });
}

export async function verifyAndSettle(
  paymentHeader: string,
  requirements: PaymentRequirements,
  cdpKeyId: string,
  cdpKeySecret: string
): Promise<PaymentResult> {
  // Step 1: Decode payment header
  const payload = decodePaymentHeader(paymentHeader);
  if (!payload) {
    return { valid: false, error: "Invalid payment header: could not decode" };
  }

  // Step 2: Import CDP Ed25519 key
  let cdpKey: CryptoKey;
  try {
    cdpKey = await importEd25519Key(cdpKeySecret);
  } catch (e) {
    return { valid: false, error: `CDP key import failed: ${e}` };
  }

  const requestBody = {
    x402Version: payload.x402Version ?? 2,
    paymentPayload: payload,
    paymentRequirements: requirements,
  };

  // Step 3: Verify with CDP facilitator
  let verifyResponse: Response;
  try {
    verifyResponse = await callFacilitator("verify", requestBody, cdpKeyId, cdpKey);
  } catch (e) {
    return { valid: false, error: `Facilitator verify failed: ${e}` };
  }

  if (!verifyResponse.ok) {
    const text = await verifyResponse.text();
    return {
      valid: false,
      error: `Facilitator verify ${verifyResponse.status}: ${text.substring(0, 300)}`,
    };
  }

  let verification: { isValid?: boolean; invalidReason?: string; payer?: string };
  try {
    verification = await verifyResponse.json();
  } catch {
    return { valid: false, error: "Facilitator returned invalid JSON" };
  }

  if (!verification.isValid) {
    return {
      valid: false,
      error: `Payment invalid: ${verification.invalidReason || "unknown"}`,
    };
  }

  // Step 4: Settle (collect USDC)
  let settleResponse: Response;
  try {
    settleResponse = await callFacilitator("settle", requestBody, cdpKeyId, cdpKey);
  } catch (e) {
    return {
      valid: false,
      payer: verification.payer,
      error: `Settlement failed: ${e}`,
    };
  }

  if (!settleResponse.ok) {
    const text = await settleResponse.text();
    return {
      valid: false,
      payer: verification.payer,
      error: `Settlement ${settleResponse.status}: ${text.substring(0, 300)}`,
    };
  }

  let settlement: {
    success?: boolean;
    transaction?: string;
    errorReason?: string;
  };
  try {
    settlement = await settleResponse.json();
  } catch {
    return {
      valid: false,
      payer: verification.payer,
      error: "Settlement returned invalid JSON",
    };
  }

  if (!settlement.success) {
    return {
      valid: false,
      payer: verification.payer,
      error: `Settlement rejected: ${settlement.errorReason || "unknown"}`,
    };
  }

  return {
    valid: true,
    payer: verification.payer,
    txHash: settlement.transaction,
  };
}
