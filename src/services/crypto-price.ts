/**
 * Real-time cryptocurrency prices via CoinGecko API
 * Free tier: 30 req/min. KV cache (60s TTL) keeps us well under.
 */

const COINGECKO_API = "https://api.coingecko.com/api/v3";

// Map common symbols to CoinGecko IDs
const SYMBOL_MAP: Record<string, string> = {
  btc: "bitcoin",
  eth: "ethereum",
  sol: "solana",
  usdc: "usd-coin",
  usdt: "tether",
  bnb: "binancecoin",
  xrp: "ripple",
  ada: "cardano",
  doge: "dogecoin",
  dot: "polkadot",
  matic: "matic-network",
  link: "chainlink",
  avax: "avalanche-2",
  atom: "cosmos",
  uni: "uniswap",
  iren: "iris-energy", // For Taeui's IREN thesis
  rklb: "rocket-lab-usa",
};

export interface CryptoPriceRequest {
  symbol?: string;
  symbols?: string[];
  vs_currency?: string;
}

export interface CryptoPriceResponse {
  prices: Record<
    string,
    {
      usd: number;
      usd_24h_change: number | null;
      usd_market_cap: number | null;
      last_updated: string;
    }
  >;
  source: string;
  cached: boolean;
}

function resolveId(symbol: string): string {
  const lower = symbol.toLowerCase().trim();
  return SYMBOL_MAP[lower] || lower;
}

export async function cryptoPrice(
  req: CryptoPriceRequest,
  cache: KVNamespace
): Promise<CryptoPriceResponse> {
  const symbols = req.symbols || (req.symbol ? [req.symbol] : ["btc"]);
  const ids = symbols.map(resolveId);
  const vsCurrency = req.vs_currency || "usd";
  const cacheKey = `crypto:${ids.sort().join(",")}:${vsCurrency}`;

  // Check cache
  const cached = await cache.get(cacheKey);
  if (cached) {
    return { ...JSON.parse(cached), cached: true };
  }

  // Fetch from CoinGecko
  const url = `${COINGECKO_API}/simple/price?ids=${ids.join(",")}&vs_currencies=${vsCurrency}&include_24hr_change=true&include_market_cap=true&include_last_updated_at=true`;

  const response = await fetch(url, {
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error(`CoinGecko API error: ${response.status}`);
  }

  const data: Record<string, Record<string, number>> = await response.json();

  // Transform to our format
  const prices: CryptoPriceResponse["prices"] = {};
  for (const symbol of symbols) {
    const id = resolveId(symbol);
    const d = data[id];
    if (d) {
      prices[symbol.toUpperCase()] = {
        usd: d[vsCurrency] ?? d.usd ?? 0,
        usd_24h_change: d[`${vsCurrency}_24h_change`] ?? null,
        usd_market_cap: d[`${vsCurrency}_market_cap`] ?? null,
        last_updated: d.last_updated_at
          ? new Date(d.last_updated_at * 1000).toISOString()
          : new Date().toISOString(),
      };
    }
  }

  const result: CryptoPriceResponse = {
    prices,
    source: "coingecko",
    cached: false,
  };

  // Cache for 60 seconds
  await cache.put(cacheKey, JSON.stringify(result), { expirationTtl: 60 });

  return result;
}
