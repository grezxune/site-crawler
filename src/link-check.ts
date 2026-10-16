import { sleep } from "./http.ts";

// Requests in flight across all hosts, and to any one host.
const TOTAL_CONCURRENCY = 6;
const PER_HOST_CONCURRENCY = 2;
const TIMEOUT_MS = 15_000;
// Statuses that mean the server refused an automated check, not that the link is dead.
const BLOCKED = new Set([401, 403, 429, 999]);

/** `ok` works. `broken` returned an error. `blocked` refused automated checks. `failed` never answered. */
export type LinkVerdict = "ok" | "broken" | "blocked" | "failed";

export interface LinkCheck {
  url: string;
  status: number | null;
  verdict: LinkVerdict;
  method: "HEAD" | "GET";
  /** Where redirects ended, when they moved the link. */
  finalUrl: string | null;
  ms: number;
  error?: string;
}

export interface LinkCheckResult {
  checked: boolean;
  checks: LinkCheck[];
  /** Links left unchecked because of the check limit. */
  skipped: number;
}

export interface LinkCheckOptions {
  userAgent: string;
  maxChecks: number;
  /** Gap between request starts on one host. */
  perHostDelayMs: number;
  onCheck?: (check: LinkCheck) => void;
}

export const NOT_CHECKED: LinkCheckResult = { checked: false, checks: [], skipped: 0 };

export function verdictFor(status: number): LinkVerdict {
  if (status < 400) return "ok";
  return BLOCKED.has(status) ? "blocked" : "broken";
}

/**
 * Checks each URL with one HEAD request. Any HEAD error gets a one-byte ranged GET, and the GET
 * decides, because some servers (Google's among them) answer HEAD with 404 for pages that work.
 * Never downloads whole files. Spreads requests across hosts and limits each host.
 */
export async function checkLinks(urls: string[], options: LinkCheckOptions): Promise<LinkCheckResult> {
  const unique = [...new Set(urls)].sort();
  const selected = unique.slice(0, options.maxChecks);
  const hosts = new Map<string, { pending: string[]; active: number; nextStart: number }>();
  for (const url of selected) {
    const host = new URL(url).host;
    const entry = hosts.get(host) ?? { pending: [], active: 0, nextStart: 0 };
    entry.pending.push(url);
    hosts.set(host, entry);
  }

  const checks: LinkCheck[] = [];
  const worker = async (): Promise<void> => {
    for (;;) {
      const now = Date.now();
      const host = [...hosts.values()].find(
        (h) => h.pending.length > 0 && h.active < PER_HOST_CONCURRENCY && h.nextStart <= now,
      );
      const url = host?.pending.shift();
      if (!host || url === undefined) {
        if ([...hosts.values()].every((h) => h.pending.length === 0)) return;
        await sleep(25);
        continue;
      }
      host.active++;
      host.nextStart = now + options.perHostDelayMs;
      try {
        const check = await checkOne(url, options.userAgent);
        checks.push(check);
        options.onCheck?.(check);
      } finally {
        host.active--;
      }
    }
  };
  await Promise.all(Array.from({ length: TOTAL_CONCURRENCY }, worker));

  checks.sort((a, b) => a.url.localeCompare(b.url));
  return { checked: true, checks, skipped: unique.length - selected.length };
}

async function checkOne(url: string, userAgent: string): Promise<LinkCheck> {
  const started = performance.now();
  const finish = (fields: Omit<LinkCheck, "url" | "ms">): LinkCheck => ({
    url, ...fields, ms: Math.round(performance.now() - started),
  });

  let method: LinkCheck["method"] = "HEAD";
  try {
    let response = await request(url, method, userAgent).catch(() => null);
    if (!response || response.status >= 400) {
      method = "GET";
      response = await request(url, method, userAgent);
    }
    if (response.status >= 500 || response.status === 429) {
      await sleep(1000);
      response = await request(url, method, userAgent);
    }
    const finalUrl = response.url && response.url !== url ? response.url : null;
    return finish({ status: response.status, verdict: verdictFor(response.status), method, finalUrl });
  } catch (error) {
    return finish({ status: null, verdict: "failed", method, finalUrl: null, error: describeError(error) });
  }
}

async function request(url: string, method: LinkCheck["method"], userAgent: string): Promise<Response> {
  const response = await fetch(url, {
    method,
    headers: { "User-Agent": userAgent, ...(method === "GET" ? { Range: "bytes=0-0" } : {}) },
    redirect: "follow",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  await response.body?.cancel();
  return response;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code;
    if (error.name === "TimeoutError") return `no response in ${TIMEOUT_MS / 1000}s`;
    return typeof code === "string" && code ? `${code}: ${error.message}` : error.message;
  }
  return String(error);
}
