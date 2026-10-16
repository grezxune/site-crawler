import { normalizeUrl } from "./urls.ts";

const MAX_REDIRECTS = 5;
const MAX_RETRIES = 2;
const TIMEOUT_MS = 20_000;

export interface FetchResult {
  /** Null when the page redirected somewhere `shouldFollow` declined. */
  response: Response | null;
  finalUrl: URL;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetches a page and follows each redirect only if `shouldFollow` accepts the target.
 * The crawler uses this to stay off other hosts and skip pages it already has.
 */
export async function fetchPage(
  url: URL,
  userAgent: string,
  shouldFollow: (next: URL) => boolean,
): Promise<FetchResult> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await fetchWithRetry(current, userAgent);
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || !location) {
      return { response, finalUrl: current };
    }
    await response.body?.cancel();
    const next = normalizeUrl(location, current);
    if (!next) throw new Error(`Bad redirect location "${location}"`);
    if (!shouldFollow(next)) return { response: null, finalUrl: next };
    current = next;
  }
  throw new Error(`More than ${MAX_REDIRECTS} redirects`);
}

/** One GET with a timeout. Retries network errors, 429, and 5xx with backoff. */
async function fetchWithRetry(url: URL, userAgent: string): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": userAgent, Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5" },
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt >= MAX_RETRIES) return response;
      await response.body?.cancel();
      await sleep(retryDelayMs(response.headers.get("retry-after"), attempt));
    } catch (error) {
      if (attempt >= MAX_RETRIES) throw error;
      await sleep(retryDelayMs(null, attempt));
    }
  }
}

function retryDelayMs(retryAfter: string | null, attempt: number): number {
  const seconds = Number(retryAfter);
  if (retryAfter && Number.isFinite(seconds)) return Math.min(seconds, 60) * 1000;
  return 1000 * 2 ** attempt;
}
