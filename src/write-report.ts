import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildReport, type Report } from "./report.ts";
import { renderMarkdown } from "./report-markdown.ts";
import { loadSiteData } from "./site-data.ts";

/** Builds the report for a crawl folder and writes `report.md` and `report.json` into it. */
export async function writeReport(outDir: string): Promise<Report> {
  const report = buildReport(await loadSiteData(outDir));
  await writeFile(join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(outDir, "report.md"), renderMarkdown(report));
  return report;
}
