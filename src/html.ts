import { collapse, decodeEntities } from "./entities.ts";
import { apiUrlsInScript } from "./found-files.ts";

// Inline script text kept per page for the API-host check. Larger scripts are cut here.
const MAX_INLINE_SCRIPT = 256 * 1024;

const LINK_SELECTORS: [selector: string, attribute: string][] = [
  ["a[href]", "href"],
  ["area[href]", "href"],
  ["frame[src]", "src"],
  ["iframe[src]", "src"],
];

// Subresources a browser loads on its own. An http:// one on an https page is mixed content.
const RESOURCE_SELECTORS: [selector: string, attribute: string][] = [
  ["img[src]", "src"],
  ["script[src]", "src"],
  ['link[rel~="stylesheet"][href]', "href"],
  ['link[rel~="icon"][href]', "href"],
  ['link[rel~="preload"][href]', "href"],
  ["iframe[src]", "src"],
  ["source[src]", "src"],
  ["video[src]", "src"],
  ["audio[src]", "src"],
];

// Text inside these never shows on the page.
const HIDDEN_TAGS = new Set(["script", "style", "noscript", "template", "svg"]);

// A new block of text starts at each of these tags.
const BLOCK_TAGS = new Set([
  "address", "article", "aside", "blockquote", "br", "dd", "div", "dl", "dt", "figcaption", "figure",
  "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "main", "nav", "ol", "p",
  "pre", "section", "table", "td", "th", "tr", "ul",
]);

export interface PageAnalysis {
  title: string | null;
  metaDescription: string | null;
  metaRobots: string | null;
  canonical: string | null;
  lang: string | null;
  generator: string | null;
  h1: string[];
  /** The page's `<base href>`. Relative links resolve against it. */
  base: string | null;
  links: string[];
  resources: string[];
  images: number;
  imagesMissingAlt: number;
  /** Frames and iframes with a source. Their content lives at another URL, often another site. */
  frames: number;
  frameSrcs: string[];
  /** External script URLs. */
  scripts: string[];
  /** URLs on API hosts or paths named in inline scripts, a sign the page loads data with JavaScript. */
  inlineApiUrls: string[];
  /** Links that go nowhere: `href="#"` or `javascript:`. */
  deadLinks: number;
  /** Visible body text, one entry per block element, whitespace collapsed. */
  textBlocks: string[];
}

/** Reads everything the crawler and report need from a page in one HTMLRewriter pass. */
export async function analyzePage(html: string): Promise<PageAnalysis> {
  const page: PageAnalysis = {
    title: null, metaDescription: null, metaRobots: null, canonical: null, lang: null, generator: null,
    h1: [], base: null, links: [], resources: [], images: 0, imagesMissingAlt: 0, frames: 0, frameSrcs: [],
    scripts: [], inlineApiUrls: [], deadLinks: 0, textBlocks: [],
  };
  const attr = (element: HTMLRewriterTypes.Element, name: string): string | null => {
    const value = element.getAttribute(name);
    return value === null ? null : decodeEntities(value).trim();
  };

  let hiddenDepth = 0;
  let block = "";
  let title: string | null = null;
  let h1: string | null = null;
  const flush = () => {
    const text = collapse(block);
    if (text) page.textBlocks.push(text);
    block = "";
  };

  let rewriter = new HTMLRewriter()
    .on("html", {
      element: (e) => {
        page.lang = attr(e, "lang") || null;
      },
    })
    .on("base[href]", {
      element: (e) => {
        page.base ??= attr(e, "href");
      },
    })
    .on("title", {
      element: (e) => {
        if (title !== null) return;
        title = "";
        e.onEndTag(() => {
          page.title = collapse(title ?? "");
        });
      },
      text: (t) => {
        if (title !== null && page.title === null) title += t.text;
      },
    })
    .on("meta[name]", {
      element: (e) => {
        const name = attr(e, "name")?.toLowerCase();
        const content = attr(e, "content");
        if (name === "description") page.metaDescription ??= content;
        if (name === "robots") page.metaRobots ??= content;
        if (name === "generator") page.generator ??= content;
      },
    })
    .on("link[rel][href]", {
      element: (e) => {
        if (attr(e, "rel")?.toLowerCase().split(/\s+/).includes("canonical")) page.canonical ??= attr(e, "href");
      },
    })
    .on("h1", {
      text: (t) => {
        if (h1 !== null) h1 += t.text;
      },
    })
    .on("img", {
      element: (e) => {
        page.images++;
        if (!e.hasAttribute("alt")) page.imagesMissingAlt++;
      },
    })
    .on("*", {
      // An element gets one end-tag handler, so every end-tag action for it is registered here.
      element: (e) => {
        const tag = e.tagName.toLowerCase();
        const hasEndTag = e.canHaveContent && !e.selfClosing;
        const onEnd: (() => void)[] = [];
        if (HIDDEN_TAGS.has(tag) && hasEndTag) {
          hiddenDepth++;
          onEnd.push(() => hiddenDepth--);
        } else if (BLOCK_TAGS.has(tag)) {
          flush();
          onEnd.push(flush);
        }
        if (tag === "h1") {
          h1 = "";
          onEnd.push(() => {
            page.h1.push(collapse(h1 ?? ""));
            h1 = null;
          });
        }
        if (hasEndTag && onEnd.length > 0) e.onEndTag(() => onEnd.forEach((run) => run()));
      },
    })
    .on("body", {
      text: (t) => {
        if (hiddenDepth === 0) block += t.text;
      },
    });

  let inlineScript = false;
  let scriptText = "";
  rewriter = rewriter.on("script", {
    element: (e) => {
      const src = attr(e, "src");
      inlineScript = !src;
      if (src) page.scripts.push(src);
    },
    text: (t) => {
      if (inlineScript && scriptText.length < MAX_INLINE_SCRIPT) scriptText += t.text;
    },
  });
  for (const [selector, name] of LINK_SELECTORS) {
    rewriter = rewriter.on(selector, {
      element: (e) => {
        const value = attr(e, name);
        if (!value) return;
        if (name === "src") page.frameSrcs.push(value);
        if (value === "#" || /^javascript:/i.test(value)) page.deadLinks++;
        else page.links.push(value);
      },
    });
  }
  for (const [selector, name] of RESOURCE_SELECTORS) {
    rewriter = rewriter.on(selector, {
      element: (e) => {
        const value = attr(e, name);
        if (value) page.resources.push(value);
      },
    });
  }

  await rewriter.transform(new Response(html)).text();
  flush();
  page.frames = page.frameSrcs.length;
  page.inlineApiUrls = apiUrlsInScript(scriptText);
  return page;
}
