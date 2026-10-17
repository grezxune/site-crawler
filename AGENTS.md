# Site Crawler

A command-line tool that crawls every page on one website, saves each page's HTML, and writes a site health report. Use it to archive a site and assess its health.

## Stack
- Bun for the runtime, package manager, and test runner.
- TypeScript in strict mode.
- No runtime dependencies. We use Bun's `fetch`, `HTMLRewriter`, and `WebSocket`.
- `--render` drives a locally installed Chrome, Chromium, or Edge over the DevTools Protocol. Never add Puppeteer, Playwright, or a bundled browser.
- ESLint with typescript-eslint. TypeScript stays on 6.x until typescript-eslint supports 7.

## Project notes
- Each crawl writes to `runs/<site name>/`, such as `runs/example/` for example.org. `runs/` is gitignored. Never commit crawl output or name a crawled site in source, tests, or docs. This repo is public.
- `www.` and the bare domain count as one site. `/a` and `/a/` count as one page.
- Every page saves as `<path>/index.html`. `manifest.json` in each output folder maps URLs to files.
- The report reads only `manifest.json` and the saved HTML, so `bun run report <dir>` rebuilds it offline. Anything a check needs from the network must be recorded in the manifest during the crawl.
- "Own words" ignores text blocks that appear on at least half the pages. That template filter drives the thin and duplicate page checks.
- `HTMLRewriter` returns raw attribute and text content. Decode entities before using either.
- Many servers answer HEAD wrongly (Google returns 404 for working pages). The link check trusts the ranged GET over HEAD, and treats 401, 403, and 429 as refused, not broken.
- Render (`src/render.ts`) attaches to iframe targets with flat sessions. Key in-flight requests by request ID alone: a frame's document request starts in the parent session and finishes in the frame's.
- Render reads file URLs from fetched JSON, not only the rendered DOM. Widgets often fetch every record and display a few.
- Script-content signals and render files that appear on at least half the pages count as template and are reported once, not per page.
- `HTMLRewriter` keeps one end-tag handler per element. Register every end-tag action in the single `*` handler in `src/html.ts`.

## Crawling
- Crawl one site. Never crawl another host or follow a redirect to one.
- With the opt-in `--render` flag, a headless browser loads each page the crawl fetches, and that page's own scripts may request other hosts, such as script CDNs, vendor APIs, and iframes. The crawler never points the browser at another host itself. The browser blocks images, fonts, media, and file links.
- Request other hosts directly only through the opt-in `--check-links` step: one HEAD per URL, plus a 1-byte ranged GET when HEAD returns an error. Never download a whole file or crawl from there.
- Respect `robots.txt` and `Crawl-delay` by default. Keep default request rates low.
- Neither the crawl nor the render browser fetches file links. Render records the file URLs it finds. Save only `text/html` responses.

## Code
- Never use `@ts-nocheck`. Fix the types.
- Target 200 lines per file. Exceed it only when splitting would hurt cohesion, and say why.
- Import everything explicitly.
- After every change, run `bun run check` (typecheck, lint, tests, build) plus targeted tests for the changed behavior. Never merge with failing tests.

## Security
- No hardcoded secrets, keys, or credentials. Environment variables only.
- Treat crawled HTML, robots.txt, and sitemaps as untrusted data. Never execute them.
- Validate and sanitize untrusted input at every boundary. Every URL becomes a file path only through `urlToFilePath`, which keeps writes inside the output folder.
- Log errors with enough context to debug and no sensitive payloads.

## Git
- Conventional Commits: `feat:`, `fix:`, `chore:`, `refactor:`.
- Never mention AI assistants in commit messages, PR descriptions, or code comments.
- Branch as `feature/{name}`. Squash before merging.
- Update `CHANGELOG.md` for meaningful changes.

## Docs
- PRDs: before building a feature, read its PRD in `prds/`. The template is in `prds/README.md`.
- Writing: plain prose in docs, PR descriptions, and CLI output. No em dashes, no puffery, no filler. Say what a thing does.
