import { describe, expect, test } from "bun:test";
import { apiUrlsInScript, blockedInRender, isFoundFile, urlsInJson } from "./found-files.ts";

describe("urlsInJson", () => {
  test("finds URLs in nested values and in HTML inside strings", () => {
    const body = JSON.stringify({
      data: [
        { agenda_file_url: "https://files.example.net/m/1/agenda.pdf", minutes: null },
        { nested: { deep: ["https://files.example.net/m/2/minutes.docx#page=2"] } },
        { description: '<p>See <a href="https://files.example.net/m/3/notes.pdf">notes</a>.</p>' },
      ],
      path: "m/4/agenda.pdf",
    });
    expect(urlsInJson(body).sort()).toEqual([
      "https://files.example.net/m/1/agenda.pdf",
      "https://files.example.net/m/2/minutes.docx",
      "https://files.example.net/m/3/notes.pdf",
    ]);
  });

  test("scans raw text when the body is not valid JSON", () => {
    expect(urlsInJson('callback({"u":"https:\\/\\/files.example.net\\/a.pdf"})')).toEqual(["https://files.example.net/a.pdf"]);
  });
});

describe("isFoundFile", () => {
  test("keeps documents and media, skips pages, scripts, and styles", () => {
    const found = (href: string) => isFoundFile(new URL(href));
    expect(found("https://x.org/a.pdf")).toBe(true);
    expect(found("https://x.org/b.XLSX?v=2")).toBe(true);
    expect(found("https://x.org/c.jpg")).toBe(true);
    expect(found("https://x.org/meetings")).toBe(false);
    expect(found("https://x.org/app.js")).toBe(false);
    expect(found("https://x.org/site.css")).toBe(false);
  });
});

describe("blockedInRender", () => {
  test("blocks images, fonts, media, and file links but lets scripts and data through", () => {
    expect(blockedInRender("https://x.org/logo", "Image")).toBe(true);
    expect(blockedInRender("https://x.org/font.woff2", "Font")).toBe(true);
    expect(blockedInRender("https://files.x.org/agenda.pdf", "Document")).toBe(true);
    expect(blockedInRender("https://cdn.x.org/widget.js", "Script")).toBe(false);
    expect(blockedInRender("https://api.x.org/meetings?page=1", "Fetch")).toBe(false);
  });
});

describe("apiUrlsInScript", () => {
  test("finds API hosts and paths, including escaped slashes", () => {
    const script = 'window.WidgetApi = "https:\\/\\/api.example.net"; fetch("https://example.org/api/items"); var home = "https://example.org/";';
    expect(apiUrlsInScript(script)).toEqual(["https://api.example.net/", "https://example.org/api/items"]);
  });
});
