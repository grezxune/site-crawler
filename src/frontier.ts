import type { Robots } from "./robots.ts";
import { isHostingPath, isSameSite, looksLikePage, pageKey, shortHash, urlToFilePath } from "./urls.ts";

/** The crawl's queue and bookkeeping: which pages are seen, queued, blocked, and saved where. */
export class Frontier {
  readonly queue: URL[] = [];
  readonly blocked: string[] = [];
  /** Links the crawl does not follow: pages on other sites, and files anywhere robots.txt allows. */
  readonly outbound = new Set<string>();
  hitPageLimit = false;
  private readonly seen = new Set<string>();
  // Lowercased so pages that differ only by case still get separate files on macOS.
  private readonly fileOwners = new Map<string, string>();
  private queued = 0;

  constructor(
    private readonly site: string,
    private readonly robots: Robots,
    private readonly maxPages: number,
  ) {}

  /** Queues a same-site page once, unless robots.txt blocks it or the page limit is reached. */
  enqueue(url: URL): void {
    if (!isSameSite(url, this.site) || !looksLikePage(url)) return;
    const key = pageKey(url);
    if (this.seen.has(key)) return;
    this.seen.add(key);
    if (!this.robots.isAllowed(url.pathname + url.search)) {
      this.blocked.push(url.href);
      return;
    }
    if (this.queued >= this.maxPages) {
      this.hitPageLimit = true;
      return;
    }
    this.queued++;
    this.queue.push(url);
  }

  /** Handles one link found on a page: queues it, or keeps it for the link check. */
  addLink(link: URL): void {
    if (isHostingPath(link)) return;
    this.enqueue(link);
    const offSite = !isSameSite(link, this.site);
    if (offSite || (!looksLikePage(link) && this.robots.isAllowed(link.pathname + link.search))) {
      this.outbound.add(link.href);
    }
  }

  /** Claims a page key a redirect leads to. False when another worker already has it. */
  claim(key: string): boolean {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }

  /** The output file for a page, made unique when two URLs map to the same path. */
  claimFile(url: URL): string {
    const key = pageKey(url);
    let file = urlToFilePath(url);
    const owner = this.fileOwners.get(file.toLowerCase());
    if (owner !== undefined && owner !== key) file = file.replace(/\.html?$/, `.${shortHash(key)}$&`);
    this.fileOwners.set(file.toLowerCase(), key);
    return file;
  }
}
