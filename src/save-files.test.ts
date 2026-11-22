import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { CHANGES_FILE, type Changes } from "./changes.ts";
import { crawl, type CrawlOptions } from "./crawler.ts";
import type { FileRecord, Manifest } from "./manifest.ts";
import { writeReport } from "./write-report.ts";

const TEXT = "Every cue is built by hand in the shop and photographed before it ships. ".repeat(5);

const page = (title: string, body: string) => new Response(
  `<html><head><title>${title}</title><link rel="stylesheet" href="/style.css"></head>
    <body><main><p>${TEXT}</p>${body}</main></body></html>`,
  { headers: { "content-type": "text/html" } },
);

// Version 2 changes /photo.jpg, adds /img/new.png, drops the link to /docs/old.pdf, and edits /docs/form.pdf,
// which has no validators and so is never asked for again.
let version = 1;
const requested: string[] = [];

function route(request: Request): Response {
  const url = new URL(request.url);
  const at = url.pathname + url.search;
  if (url.pathname === "/") {
    return page("Home", `
      <img src="/img/logo.png" alt=""> <img src="https://other.test/x.png" alt=""> <img src="/photo.jpg" alt="">
      <img src="/big.jpg" alt=""> <img src="/missing.png" alt=""> <a href="/docs/form.pdf">Form</a>
      ${version === 1 ? `<a href="/docs/old.pdf">Old</a>` : `<img src="/img/new.png" alt="">`}
      <a href="/list?order=price">By price</a> <a href="/list?order=name&page=2">Page 2</a> <a href="/files">Files</a>`);
  }
  if (url.pathname === "/list") return page(`List ${url.search}`, `<a href="/list?page=2">Next</a>`);
  if (url.pathname === "/files") return page("Files", "A page that shares the files folder name.");
  if (at === "/img/logo.png") {
    if (request.headers.get("if-none-match") === '"logo-1"') return new Response(null, { status: 304 });
    return new Response("logo", { headers: { "content-type": "image/png", etag: '"logo-1"' } });
  }
  if (at === "/photo.jpg") {
    const lastModified = version === 1 ? "Mon, 02 Nov 2026 10:00:00 GMT" : "Sat, 21 Nov 2026 10:00:00 GMT";
    if (request.headers.get("if-modified-since") === lastModified) return new Response(null, { status: 304 });
    return new Response(`photo ${version}`, { headers: { "content-type": "image/jpeg", "last-modified": lastModified } });
  }
  if (at === "/docs/form.pdf") return new Response(`%PDF form ${version}`, { headers: { "content-type": "application/pdf" } });
  if (at === "/docs/old.pdf") return new Response("%PDF old", { headers: { "content-type": "application/pdf" } });
  if (at === "/img/new.png" && version === 2) return new Response("new", { headers: { "content-type": "image/png" } });
  if (at === "/big.jpg") return new Response("x".repeat(2048), { headers: { "content-type": "image/jpeg" } });
  return new Response("Not found", { status: 404 });
}

let server: Server<undefined>;
const tempDirs: string[] = [];

const options = (outDir: string, extra: Partial<CrawlOptions> = {}): CrawlOptions => ({
  startUrl: `http://localhost:${server.port}/`, outDir, concurrency: 2, delayMs: 0, maxPages: 100,
  useSitemap: false, respectRobots: false, userAgent: "site-crawler/test", checkLinks: false, maxLinkChecks: 0,
  render: false, saveFiles: true, maxFileBytes: 1024, stripParams: ["order"], ...extra,
});
const file = (manifest: Manifest, pathname: string): FileRecord | undefined =>
  manifest.files?.find((record) => new URL(record.url).pathname === pathname);
const paths = (list: { url: string }[] | undefined) => (list ?? []).map((entry) => new URL(entry.url).pathname).sort();
const tempDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), "site-crawler-files-"));
  tempDirs.push(dir);
  return dir;
};

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      requested.push(url.pathname + url.search);
      return route(request);
    },
  });
});

afterAll(async () => {
  await server.stop(true);
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("--save-files", () => {
  let outDir: string;
  let first: Manifest;
  let second: Manifest;
  let changes: Changes;
  let secondRequests: string[];

  beforeAll(async () => {
    version = 1;
    outDir = await tempDir();
    requested.length = 0;
    first = await crawl(options(outDir));
    version = 2;
    requested.length = 0;
    second = await crawl(options(outDir));
    secondRequests = [...requested];
    if (!second.changes) throw new Error("The second crawl recorded no changes");
    changes = second.changes;
  });

  test("saves this site's images and documents under files/, and nothing from other hosts", async () => {
    expect(file(first, "/img/logo.png")).toMatchObject({ outcome: "saved", file: "files/img/logo.png", bytes: 4, etag: '"logo-1"' });
    expect(file(first, "/img/logo.png")?.sha256).toBe(new Bun.CryptoHasher("sha256").update("logo").digest("hex"));
    expect(await readFile(join(outDir, "files/docs/form.pdf"), "utf8")).toBe("%PDF form 1");
    expect(first.files?.some((record) => record.url.includes("other.test"))).toBe(false);
    expect(file(first, "/style.css")).toBeUndefined();
    expect(first.files?.every((record) => record.change === undefined)).toBe(true);
  });

  test("records files it could not save", async () => {
    expect(file(first, "/big.jpg")).toMatchObject({ outcome: "too-large", file: null });
    expect(await Bun.file(join(outDir, "files/big.jpg")).exists()).toBe(false);
    expect(file(first, "/missing.png")).toMatchObject({ outcome: "http-error", status: 404 });
  });

  test("keeps a page named files out of the files folder", () => {
    expect(first.pages.find((record) => new URL(record.url).pathname === "/files")?.file).toBe("files_/index.html");
  });

  test("--strip-param folds sort copies of a list into one page", () => {
    const lists = first.pages.map((record) => new URL(record.url)).filter((url) => url.pathname === "/list");
    expect(lists.map((url) => url.search).sort()).toEqual(["", "?page=2"]);
    expect(first.settings.stripParams).toEqual(["order"]);
  });

  test("asks for a known file only with its validators, and keeps one that has none without a request", () => {
    expect(file(second, "/img/logo.png")).toMatchObject({ change: "unchanged", notModified: true, file: "files/img/logo.png" });
    expect(file(second, "/docs/form.pdf")).toMatchObject({ change: "unchanged", notRequested: true });
    expect(secondRequests).not.toContain("/docs/form.pdf");
  });

  test("lists new, changed, and removed files", () => {
    expect(paths(changes.savedFiles?.new)).toEqual(["/img/new.png"]);
    expect(paths(changes.savedFiles?.changed)).toEqual(["/photo.jpg"]);
    expect(changes.savedFiles?.removed).toEqual([
      expect.objectContaining({ file: "files/docs/old.pdf", reason: "no page links to it anymore" }),
    ]);
    expect(changes.savedFiles?.notDownloaded).toBe(2);
  });

  test("copies new and changed files to the changes folder and keeps removed ones on disk", async () => {
    expect(await readFile(join(outDir, changes.dir ?? "", "files/photo.jpg"), "utf8")).toBe("photo 2");
    expect(await readFile(join(outDir, changes.dir ?? "", "files/img/new.png"), "utf8")).toBe("new");
    expect(await Bun.file(join(outDir, changes.dir ?? "", "files/img/logo.png")).exists()).toBe(false);
    expect(await readFile(join(outDir, "files/photo.jpg"), "utf8")).toBe("photo 2");
    expect(await Bun.file(join(outDir, "files/docs/old.pdf")).exists()).toBe(true);
    const written = JSON.parse(await readFile(join(outDir, changes.dir ?? "", CHANGES_FILE), "utf8")) as Changes;
    expect(written.savedFiles?.new).toHaveLength(1);
  });

  test("the report counts the saved files", async () => {
    const markdown = await writeReport(outDir).then(() => readFile(join(outDir, "report.md"), "utf8"));
    expect(markdown).toContain("| Files saved | 4 of 6 files");
    expect(markdown).toContain("Saved files: 1 new, 1 changed, 1 removed");
  });
});

describe("--save-files over other crawls", () => {
  test("does not compare files when the earlier crawl saved none", async () => {
    version = 1;
    const outDir = await tempDir();
    await crawl(options(outDir, { saveFiles: false }));
    const manifest = await crawl(options(outDir));
    expect(manifest.files?.length).toBeGreaterThan(0);
    expect(manifest.changes?.savedFiles).toBeUndefined();
  });

  test("does not list pages a stripped parameter now excludes as removed", async () => {
    version = 1;
    const outDir = await tempDir();
    const before = await crawl(options(outDir, { stripParams: [], saveFiles: false }));
    expect(before.pages.some((record) => record.url.includes("order="))).toBe(true);
    const manifest = await crawl(options(outDir, { saveFiles: false }));
    expect(manifest.changes?.pages.removed).toEqual([]);
  });

  test("downloads a file again when the earlier manifest gives it an unsafe path", async () => {
    version = 1;
    const outDir = await tempDir();
    await crawl(options(outDir));
    const manifestPath = join(outDir, "manifest.json");
    const edited = JSON.parse(await readFile(manifestPath, "utf8")) as Manifest;
    for (const record of edited.files ?? []) if (record.url.endsWith("/img/logo.png")) record.file = "../../escape.png";
    await writeFile(manifestPath, JSON.stringify(edited));
    const manifest = await crawl(options(outDir));
    expect(file(manifest, "/img/logo.png")).toMatchObject({ file: "files/img/logo.png", change: "new" });
  });
});
