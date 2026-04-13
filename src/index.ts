import { Hono } from "hono";
import { cors } from "hono/cors";
import { verifyAndSettle, type PaymentRequirements } from "./payment";
import { cryptoPrice, type CryptoPriceRequest } from "./services/crypto-price";
import { webFetch, type WebFetchRequest } from "./services/web-fetch";
import { onchainBalance, type OnchainBalanceRequest } from "./services/onchain";

type Env = {
  WALLET_ADDRESS: string;
  CDP_API_KEY_ID: string;
  CDP_API_KEY_SECRET: string;
  INTERNAL_SECRET: string;
  CACHE: KVNamespace;
};

const WALLET = "0xEF6a2101eaBE4FD682aeA512C87BC26E191D882b";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const app = new Hono<{ Bindings: Env }>();
app.use("/*", cors());

// ── Pricing ──

const PRICES: Record<string, PaymentRequirements> = {
  crypto: {
    scheme: "exact",
    network: "eip155:8453",
    asset: USDC_BASE,
    payTo: WALLET,
    amount: "1000", // $0.001
    maxTimeoutSeconds: 300,
  },
  web: {
    scheme: "exact",
    network: "eip155:8453",
    asset: USDC_BASE,
    payTo: WALLET,
    amount: "2000", // $0.002
    maxTimeoutSeconds: 300,
  },
  onchain: {
    scheme: "exact",
    network: "eip155:8453",
    asset: USDC_BASE,
    payTo: WALLET,
    amount: "1000", // $0.001
    maxTimeoutSeconds: 300,
  },
};

// ── x402 Payment Required response ──

function paymentRequired(c: any, price: string, description: string, name: string) {
  const payload = {
    x402Version: 2,
    resource: { url: c.req.url, description, mimeType: "application/json" },
    accepts: [
      {
        scheme: "exact",
        network: "eip155:8453",
        asset: USDC_BASE,
        payTo: WALLET,
        amount: price,
        maxTimeoutSeconds: 300,
        extra: {
          name,
          facilitator: "https://api.cdp.coinbase.com/platform/v2/x402",
        },
      },
    ],
  };

  const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
  return c.json(payload, 402, { "PAYMENT-REQUIRED": encoded });
}

// ── Payment verification helper ──

const FREE_TIER_LIMIT = 100; // requests per day per IP

async function checkFreeTier(c: any): Promise<boolean> {
  const ip = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || "unknown";
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const key = `ratelimit:${ip}:${today}`;

  const current = parseInt((await c.env.CACHE.get(key)) || "0");
  if (current >= FREE_TIER_LIMIT) return false;

  await c.env.CACHE.put(key, String(current + 1), { expirationTtl: 86400 });
  return true;
}

async function requirePayment(
  c: any,
  requirements: PaymentRequirements,
  description: string,
  name: string
): Promise<Response | null> {
  // Internal auth from sibling services (Checkpoint402 enhance pipeline)
  const internalAuth = c.req.header("X-Internal-Auth");
  if (internalAuth && c.env.INTERNAL_SECRET && internalAuth === c.env.INTERNAL_SECRET) {
    return null;
  }

  // Free tier: 100 requests/day per IP (no payment needed)
  if (await checkFreeTier(c)) {
    return null;
  }

  // Over free tier — require x402 payment
  const header = c.req.header("X-Payment") || c.req.header("x-payment");

  if (!header) {
    return paymentRequired(c, requirements.amount, description, name);
  }

  const result = await verifyAndSettle(
    header,
    requirements,
    c.env.CDP_API_KEY_ID,
    c.env.CDP_API_KEY_SECRET
  );

  if (!result.valid) {
    return c.json(
      { error: "Payment verification failed", reason: result.error },
      402
    );
  }

  return null;
}

// ── Health check ──

app.get("/", (c) => {
  return c.json({
    service: "data402",
    description:
      "Real-time data services for AI agents — the eyes and hands Claude doesn't have. Crypto prices, web content, on-chain data. Paid via x402 micropayments.",
    version: "0.1.0",
    endpoints: {
      "POST /crypto/price": {
        description: "Real-time cryptocurrency prices (CoinGecko)",
        price: "$0.001 USDC",
        input: { symbol: "BTC", symbols: ["BTC", "ETH", "SOL"] },
      },
      "POST /web/fetch": {
        description: "Fetch and extract content from any URL",
        price: "$0.002 USDC",
        input: { url: "https://example.com", max_length: 10000 },
      },
      "POST /onchain/balance": {
        description: "On-chain wallet balances (Base network)",
        price: "$0.001 USDC",
        input: { address: "0x..." },
      },
    },
    payment: {
      protocol: "x402",
      network: "base (eip155:8453)",
      asset: "USDC",
      payTo: WALLET,
    },
  });
});

// ── Crypto Price ──

app.get("/crypto/price", (c) =>
  paymentRequired(c, "1000", "Real-time crypto prices", "data402 Crypto Price")
);

app.post("/crypto/price", async (c) => {
  const blocked = await requirePayment(
    c,
    PRICES.crypto,
    "Real-time crypto prices",
    "data402 Crypto Price"
  );
  if (blocked) return blocked;

  let body: CryptoPriceRequest;
  try {
    body = await c.req.json<CryptoPriceRequest>();
  } catch {
    body = { symbol: "BTC" };
  }

  try {
    const result = await cryptoPrice(body, c.env.CACHE);
    return c.json(result);
  } catch (e) {
    return c.json(
      { error: `Crypto price fetch failed: ${e instanceof Error ? e.message : e}` },
      500
    );
  }
});

// ── Web Fetch ──

app.get("/web/fetch", (c) =>
  paymentRequired(c, "2000", "Web content extraction", "data402 Web Fetch")
);

app.post("/web/fetch", async (c) => {
  const blocked = await requirePayment(
    c,
    PRICES.web,
    "Web content extraction",
    "data402 Web Fetch"
  );
  if (blocked) return blocked;

  let body: WebFetchRequest;
  try {
    body = await c.req.json<WebFetchRequest>();
  } catch {
    return c.json({ error: "Invalid JSON body. Required: { url: string }" }, 400);
  }

  if (!body.url) {
    return c.json({ error: "Missing required field: url" }, 400);
  }

  try {
    const result = await webFetch(body, c.env.CACHE);
    return c.json(result);
  } catch (e) {
    return c.json(
      { error: `Web fetch failed: ${e instanceof Error ? e.message : e}` },
      500
    );
  }
});

// ── On-chain Balance ──

app.get("/onchain/balance", (c) =>
  paymentRequired(c, "1000", "On-chain wallet balance (Base)", "data402 Onchain Balance")
);

app.post("/onchain/balance", async (c) => {
  const blocked = await requirePayment(
    c,
    PRICES.onchain,
    "On-chain wallet balance (Base)",
    "data402 Onchain Balance"
  );
  if (blocked) return blocked;

  let body: OnchainBalanceRequest;
  try {
    body = await c.req.json<OnchainBalanceRequest>();
  } catch {
    return c.json(
      { error: "Invalid JSON body. Required: { address: string }" },
      400
    );
  }

  if (!body.address) {
    return c.json({ error: "Missing required field: address" }, 400);
  }

  try {
    const result = await onchainBalance(body, c.env.CACHE);
    return c.json(result);
  } catch (e) {
    return c.json(
      { error: `Onchain query failed: ${e instanceof Error ? e.message : e}` },
      500
    );
  }
});

export default app;
