interface Rule {
  allow: boolean;
  pattern: string;
  regex: RegExp;
}

export interface Robots {
  /** False when the site has no readable robots.txt. */
  found: boolean;
  /** True when the path (with its query string) may be crawled. */
  isAllowed(pathAndQuery: string): boolean;
  /** Seconds to wait between requests, if the site asks for it. */
  crawlDelay: number | null;
  sitemaps: string[];
}

export const ALLOW_ALL: Robots = { found: false, isAllowed: () => true, crawlDelay: null, sitemaps: [] };

/**
 * Parses robots.txt and keeps the group that applies to our user agent.
 * A group naming our agent wins over the `*` group. Within a group the longest
 * matching rule wins, and Allow wins a tie, as in RFC 9309.
 */
export function parseRobots(text: string, userAgent: string): Robots {
  const agentToken = userAgent.split("/")[0]?.toLowerCase() ?? "";
  const groups: { agents: string[]; rules: Rule[]; crawlDelay: number | null }[] = [];
  const sitemaps: string[] = [];
  let current: (typeof groups)[number] | null = null;
  let lastWasAgent = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (field === "sitemap") {
      if (value) sitemaps.push(value);
      continue;
    }
    if (field === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [], crawlDelay: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if ((field === "allow" || field === "disallow") && value) {
      current.rules.push({ allow: field === "allow", pattern: value, regex: patternToRegex(value) });
    } else if (field === "crawl-delay") {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds >= 0) current.crawlDelay = seconds;
    }
  }

  const group =
    groups.find((g) => g.agents.some((agent) => agent !== "*" && agentToken.includes(agent))) ??
    groups.find((g) => g.agents.includes("*"));
  const rules = group?.rules ?? [];

  return {
    found: true,
    crawlDelay: group?.crawlDelay ?? null,
    sitemaps,
    isAllowed(pathAndQuery) {
      let best: Rule | null = null;
      for (const rule of rules) {
        if (!rule.regex.test(pathAndQuery)) continue;
        const longer = !best || rule.pattern.length > best.pattern.length;
        const tieAllow = best !== null && rule.pattern.length === best.pattern.length && rule.allow;
        if (longer || tieAllow) best = rule;
      }
      return best?.allow ?? true;
    },
  };
}

/** Fetches and parses robots.txt. A missing or unreadable file allows everything. */
export async function loadRobots(origin: string, userAgent: string): Promise<Robots> {
  try {
    const res = await fetch(new URL("/robots.txt", origin), {
      headers: { "User-Agent": userAgent },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return ALLOW_ALL;
    return parseRobots(await res.text(), userAgent);
  } catch {
    return ALLOW_ALL;
  }
}

function patternToRegex(pattern: string): RegExp {
  const anchored = pattern.endsWith("$");
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`);
}
