import { resolve } from "node:path";
import type { Report } from "./report.ts";
import { writeReport } from "./write-report.ts";

const USAGE = `Usage: bun run report <crawl folder>

Rebuilds report.md and report.json from a finished crawl without fetching anything.
Example: bun run report runs/example`;

/** Prints the headline findings after a report is written. */
export function printReportSummary(report: Report, outDir: string): void {
  const lines: [string, number][] = [
    ["broken pages", report.broken.length],
    ["URLs that redirect", report.redirects.length],
    ["likely useless pages", report.likelyUseless.length],
    ["thin pages", report.thin.length],
    ["duplicate page groups", report.duplicates.length],
    ["orphan pages", report.orphans.length],
    ["stale pages", report.stale.length],
    ["images missing alt text", report.accessibility.imagesMissingAlt],
    ["pages with script-loaded content", report.scriptContent.pages.length],
  ];
  if (report.scriptContent.rendered) lines.push(["files found by render", report.scriptContent.totals.files]);
  if (report.linkChecks.checked) {
    const { counts } = report.linkChecks;
    lines.splice(1, 0, ["broken files and external links", counts.broken + counts.failed]);
  }
  console.log("\nReport:");
  for (const [label, count] of lines) console.log(`  ${String(count).padStart(5)}  ${label}`);
  console.log(`\n${resolve(outDir, "report.md")}`);
}

async function main(): Promise<void> {
  const dir = Bun.argv[2];
  if (!dir || dir === "-h" || dir === "--help") {
    console.log(USAGE);
    process.exit(dir ? 0 : 1);
  }
  const outDir = resolve(dir);
  printReportSummary(await writeReport(outDir), outDir);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
