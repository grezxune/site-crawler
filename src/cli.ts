import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { crawl } from "./crawler.ts";
import type { PageOutcome } from "./manifest.ts";
import { printReportSummary } from "./report-cli.ts";
import { normalizeUrl, siteDirName } from "./urls.ts";
import { writeReport } from "./write-report.ts";

const USER_AGENT = "site-crawler/0.1";
const RUNS_DIR = resolve(import.meta.dir, "..", "runs");

const USAGE = `Usage: bun run crawl <url> [options]

Crawls every page on the site at <url>, saves each page's HTML, and writes
report.md and report.json about the site's health.
Output goes to runs/<site name>, for example runs/example for example.org.

Options:
  --out <dir>          Output folder (default: runs/<site name>)
  --concurrency <n>    Parallel requests (default: 3)
  --delay <ms>         Pause per worker after each request (default: 250)
  --max-pages <n>      Stop queueing new pages after this many (default: 5000)
  --no-sitemap         Do not seed the crawl from sitemap.xml
  --check-links        After the crawl, check every linked file and external link
                       with one HEAD request each (a 1-byte GET confirms any error)
  --max-link-checks <n>  Most links to check (default: 2000)
  --ignore-robots      Do not read robots.txt
  -h, --help           Show this help`;

function positiveInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`--${name} must be a whole number`);
  return parsed;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    allowPositionals: true,
    options: {
      out: { type: "string" },
      concurrency: { type: "string" },
      delay: { type: "string" },
      "max-pages": { type: "string" },
      "no-sitemap": { type: "boolean", default: false },
      "ignore-robots": { type: "boolean", default: false },
      "check-links": { type: "boolean", default: false },
      "max-link-checks": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  const startUrl = positionals[0];
  if (values.help || !startUrl) {
    console.log(USAGE);
    process.exit(values.help ? 0 : 1);
  }
  const start = normalizeUrl(startUrl);
  if (!start) throw new Error(`Not an http(s) URL: ${startUrl}`);

  const outDir = resolve(values.out ?? resolve(RUNS_DIR, siteDirName(start.hostname)));
  console.log(`Crawling ${start.href}\nSaving to ${outDir}\n`);

  const began = performance.now();
  let linksChecked = 0;
  const result = await crawl({
    startUrl: start.href,
    outDir,
    concurrency: Math.max(1, positiveInt(values.concurrency, 3, "concurrency")),
    delayMs: positiveInt(values.delay, 250, "delay"),
    maxPages: positiveInt(values["max-pages"], 5000, "max-pages"),
    useSitemap: !values["no-sitemap"],
    respectRobots: !values["ignore-robots"],
    userAgent: USER_AGENT,
    checkLinks: values["check-links"],
    maxLinkChecks: positiveInt(values["max-link-checks"], 2000, "max-link-checks"),
    onLinkCheck(check) {
      linksChecked++;
      if (check.verdict !== "ok") console.log(`  link ${check.verdict.padEnd(8)} ${check.status ?? check.error ?? ""}  ${check.url}`);
      else if (linksChecked % 25 === 0) console.log(`  checked ${linksChecked} links`);
    },
    onPage(page, done) {
      const status = page.status ?? "---";
      const detail = page.file ?? page.error ?? page.finalUrl ?? "";
      console.log(`[${done}] ${status} ${page.outcome.padEnd(16)} ${page.url}  ${detail}`);
    },
  });

  const counts = new Map<PageOutcome, number>();
  for (const page of result.pages) counts.set(page.outcome, (counts.get(page.outcome) ?? 0) + 1);
  const seconds = ((performance.now() - began) / 1000).toFixed(1);

  console.log(`\nDone in ${seconds}s. Fetched ${result.pages.length} URLs.`);
  for (const [outcome, count] of [...counts].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${outcome.padEnd(16)} ${count}`);
  }
  if (result.robots.blocked.length > 0) {
    console.log(`  blocked by robots.txt: ${result.robots.blocked.length}`);
  }
  if (result.hitPageLimit) console.log("  Stopped queueing at --max-pages. Some pages were not fetched.");
  if (result.linkChecks?.checked) {
    const verdicts = Object.groupBy(result.linkChecks.checks, (check) => check.verdict);
    const summary = Object.entries(verdicts).map(([verdict, checks]) => `${checks?.length ?? 0} ${verdict}`).join(", ");
    const skipped = result.linkChecks.skipped ? ` ${result.linkChecks.skipped} skipped by --max-link-checks.` : "";
    console.log(`  Checked ${result.linkChecks.checks.length} links: ${summary || "none found"}.${skipped}`);
  }

  printReportSummary(await writeReport(outDir), outDir);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
