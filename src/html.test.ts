import { describe, expect, test } from "bun:test";
import { analyzePage } from "./html.ts";

describe("analyzePage", () => {
  test("finds links, frames, the base href, and dead links", async () => {
    const page = await analyzePage(`<html><head><base href="/sub/"></head><body>
      <a href="/a">A</a><a>no href</a><a href="b?x=1&amp;y=2">B</a><a href="#">Top</a>
      <a href="javascript:void(0)">JS</a><map><area href="/c"></map><iframe src="/d"></iframe>
    </body></html>`);
    expect(page.base).toBe("/sub/");
    expect(page.links).toEqual(["/a", "b?x=1&y=2", "/c", "/d"]);
    expect(page.deadLinks).toBe(2);
  });

  test("reads search metadata", async () => {
    const page = await analyzePage(`<html lang="en"><head>
      <title> Board &amp; Committees </title><meta name="description" content="Who serves.">
      <meta name="robots" content="noindex"><meta name="generator" content="TownWeb">
      <link rel="canonical" href="https://x.org/board"></head>
      <body><h1>Board <b>members</b></h1><h1>Second</h1></body></html>`);
    expect(page).toMatchObject({
      title: "Board & Committees",
      metaDescription: "Who serves.",
      metaRobots: "noindex",
      generator: "TownWeb",
      canonical: "https://x.org/board",
      lang: "en",
      h1: ["Board members", "Second"],
    });
  });

  test("splits visible text into blocks and skips scripts and styles", async () => {
    const page = await analyzePage(`<body><div>Hello <b>big</b> world<script>var x = "hidden";</script>
      <p>Pay &amp; play</p></div><style>p { color: red }</style><ul><li>One</li><li>Two</li></ul></body>`);
    expect(page.textBlocks).toEqual(["Hello big world", "Pay & play", "One", "Two"]);
  });

  test("counts images without alt and collects subresources", async () => {
    const page = await analyzePage(`<body><img src="http://x.org/a.png"><img src="b.png" alt="">
      <script src="/app.js"></script><link rel="stylesheet" href="/s.css"></body>`);
    expect(page.images).toBe(2);
    expect(page.imagesMissingAlt).toBe(1);
    expect(page.resources).toEqual(["http://x.org/a.png", "b.png", "/app.js", "/s.css"]);
  });

  test("records script sources, frame sources, and API hosts named in inline scripts", async () => {
    const page = await analyzePage(`<body><script src="https://widgets.example.net/w.js"></script>
      <script>window.WidgetApi = "https:\\/\\/api.example.net"; var home = "https://example.org/";</script>
      <iframe src="https://calendar.example.net/embed"></iframe></body>`);
    expect(page.scripts).toEqual(["https://widgets.example.net/w.js"]);
    expect(page.frameSrcs).toEqual(["https://calendar.example.net/embed"]);
    expect(page.frames).toBe(1);
    expect(page.inlineApiUrls).toEqual(["https://api.example.net/"]);
  });
});
