/**
 * On-chain data service — Base network
 * ETH balance, USDC balance, ERC-20 token balances via JSON-RPC.
 */

const BASE_RPC = "https://mainnet.base.org";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

export interface OnchainBalanceRequest {
  address: string;
  network?: string;
}

export interface OnchainBalanceResponse {
  address: string;
  network: string;
  eth_balance: string;
  usdc_balance: string;
  block_number: number;
  fetched_at: string;
  cached: boolean;
}

/** Call Base JSON-RPC */
async function rpcCall(
  method: string,
  params: unknown[]
): Promise<unknown> {
  const response = await fetch(BASE_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    }),
  });

  if (!response.ok) {
    throw new Error(`RPC error: ${response.status}`);
  }

  const data: { result?: unknown; error?: { message: string } } =
    await response.json();
  if (data.error) {
    throw new Error(`RPC error: ${data.error.message}`);
  }
  return data.result;
}

/** Convert hex wei to decimal ETH string */
function weiToEth(hexWei: string): string {
  const wei = BigInt(hexWei);
  const eth = Number(wei) / 1e18;
  return eth.toFixed(6);
}

/** Convert hex USDC units to decimal (6 decimals) */
function toUsdc(hexAmount: string): string {
  const raw = BigInt(hexAmount);
  const usdc = Number(raw) / 1e6;
  return usdc.toFixed(2);
}

export async function onchainBalance(
  req: OnchainBalanceRequest,
  cache: KVNamespace
): Promise<OnchainBalanceResponse> {
  if (!req.address) throw new Error("address is required");

  // Basic address validation
  if (!/^0x[0-9a-fA-F]{40}$/.test(req.address)) {
    throw new Error("Invalid Ethereum address");
  }

  const address = req.address.toLowerCase();
  const cacheKey = `onchain:${address}`;

  // Check cache (30s TTL)
  const cached = await cache.get(cacheKey);
  if (cached) {
    return { ...JSON.parse(cached), cached: true };
  }

  // Parallel RPC calls: ETH balance + USDC balance + block number
  const [ethBalanceHex, usdcBalanceHex, blockHex] = await Promise.all([
    rpcCall("eth_getBalance", [address, "latest"]) as Promise<string>,
    rpcCall("eth_call", [
      {
        to: USDC_BASE,
        // balanceOf(address) = 0x70a08231 + address padded to 32 bytes
        data: `0x70a08231000000000000000000000000${address.slice(2)}`,
      },
      "latest",
    ]) as Promise<string>,
    rpcCall("eth_blockNumber", []) as Promise<string>,
  ]);

  const result: OnchainBalanceResponse = {
    address: req.address,
    network: "base",
    eth_balance: weiToEth(ethBalanceHex),
    usdc_balance: toUsdc(usdcBalanceHex || "0x0"),
    block_number: parseInt(blockHex, 16),
    fetched_at: new Date().toISOString(),
    cached: false,
  };

  // Cache 30 seconds
  await cache.put(cacheKey, JSON.stringify(result), { expirationTtl: 30 });

  return result;
}
