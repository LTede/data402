/**
 * Web content extraction service
 * Fetches any URL, strips HTML, returns clean text content.
 */

export interface WebFetchRequest {
  url: string;
  max_length?: number;
}

export interface WebFetchResponse {
  url: string;
  title: string;
  content: string;
  content_length: number;
  fetched_at: string;
  cached: boolean;
}

/** Strip HTML tags and extract text content */
function htmlToText(html: string): string {
  // Remove script and style blocks
  let text = html.replace(/<script[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, "");
  // Remove HTML tags
  text = text.replace(/<[^>]+>/g, " ");
  // Decode common entities
  text = text.replace(/&amp;/g, "&");
  text = text.replace(/&lt;/g, "<");
  text = text.replace(/&gt;/g, ">");
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&nbsp;/g, " ");
  // Collapse whitespace
  text = text.replace(/\s+/g, " ").trim();
  return text;
}

/** Extract title from HTML */
function extractTitle(html: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? match[1].trim() : "";
}

export async function webFetch(
  req: WebFetchRequest,
  cache: KVNamespace
): Promise<WebFetchResponse> {
  if (!req.url) throw new Error("url is required");

  // Validate URL
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(req.url);
  } catch {
    throw new Error("Invalid URL");
  }

  // Block private/internal URLs
  const hostname = parsedUrl.hostname;
  if (
    hostname === "localhost" ||
    hostname.startsWith("127.") ||
    hostname.startsWith("10.") ||
    hostname.startsWith("192.168.") ||
    hostname.endsWith(".local")
  ) {
    throw new Error("Private/internal URLs not allowed");
  }

  const maxLength = Math.min(req.max_length || 10000, 50000);
  const cacheKey = `web:${req.url}`;

  // Check cache (5 min TTL)
  const cached = await cache.get(cacheKey);
  if (cached) {
    const parsed = JSON.parse(cached) as WebFetchResponse;
    return { ...parsed, cached: true, content: parsed.content.substring(0, maxLength) };
  }

  // Fetch URL
  const response = await fetch(req.url, {
    headers: {
      "User-Agent": "data402/0.1 (x402 data service)",
      Accept: "text/html,application/xhtml+xml,text/plain,application/json",
    },
    redirect: "follow",
  });

  if (!response.ok) {
    throw new Error(`Fetch failed: HTTP ${response.status}`);
  }

  const contentType = response.headers.get("content-type") || "";
  const rawText = await response.text();

  let content: string;
  let title: string;

  if (contentType.includes("text/html") || contentType.includes("xhtml")) {
    title = extractTitle(rawText);
    content = htmlToText(rawText);
  } else if (contentType.includes("application/json")) {
    title = "JSON response";
    content = rawText;
  } else {
    title = "";
    content = rawText;
  }

  // Trim to max length
  content = content.substring(0, 50000);

  const result: WebFetchResponse = {
    url: req.url,
    title,
    content: content.substring(0, maxLength),
    content_length: content.length,
    fetched_at: new Date().toISOString(),
    cached: false,
  };

  // Cache for 5 minutes (store full content)
  await cache.put(
    cacheKey,
    JSON.stringify({ ...result, content }),
    { expirationTtl: 300 }
  );

  return result;
}
