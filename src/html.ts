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
  /** Frames and iframes. Their content lives at another URL, often another site. */
  frames: number;
  /** Links that go nowhere: `href="#"` or `javascript:`. */
  deadLinks: number;
  /** Visible body text, one entry per block element, whitespace collapsed. */
  textBlocks: string[];
}

/** Reads everything the crawler and report need from a page in one HTMLRewriter pass. */
export async function analyzePage(html: string): Promise<PageAnalysis> {
  const page: PageAnalysis = {
    title: null, metaDescription: null, metaRobots: null, canonical: null, lang: null, generator: null,
    h1: [], base: null, links: [], resources: [], images: 0, imagesMissingAlt: 0, frames: 0, deadLinks: 0,
    textBlocks: [],
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

  for (const selector of ["frame", "iframe"]) {
    rewriter = rewriter.on(selector, {
      element: () => {
        page.frames++;
      },
    });
  }
  for (const [selector, name] of LINK_SELECTORS) {
    rewriter = rewriter.on(selector, {
      element: (e) => {
        const value = attr(e, name);
        if (!value) return;
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
  return page;
}

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** HTMLRewriter returns raw attribute and text content, so entities must be decoded here. */
export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, body: string) => {
    if (body[0] !== "#") return NAMED_ENTITIES[body.toLowerCase()] ?? entity;
    const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  });
}

function collapse(text: string): string {
  return decodeEntities(text).replace(/\s+/g, " ").trim();
}
