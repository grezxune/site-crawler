---
title: Save files
status: approved
---

## Problem
A person rebuilding a site needs its photographs and documents as well as its pages. Today the crawl saves only HTML and lists file URLs, so the import has to download every image itself and work out which ones it already has. A shop site with a few thousand product pages has over ten thousand product photos, and its catalog pages link each list in several sort orders, so a 5,000-page crawl fills up with copies and never reaches some products.

## Goals
- One crawl keeps a local copy of every page and every same-site image, media file, and document those pages use.
- A second crawl of an unchanged site downloads no file bodies from servers that answer conditional requests, and rewrites no saved file.
- `changes.json` lists every saved file that is new, changed, or no longer linked, so the import reads only those.
- A crawl of a shop with sort links reaches every list page without fetching each sort order.

## Non-goals
- Saving stylesheets, scripts, and fonts. They are the site's theme, not its content.
- Downloading files from other hosts. The crawl stays on one site, as every other step does.
- Downloading every size of an image a page could request through `srcset`. The `src` of each image is saved.
- Detecting a change in a file with no `ETag` or `Last-Modified` at the same URL. That needs a full download on every crawl. `--fresh` downloads every file again.

## Users and flows
A person keeping a site import current wants the site's pages and files on disk, and later only what changed.

1. They run `bun run crawl https://example.org/ --save-files --strip-param order`. The crawl saves every page, then every same-site file the pages use, to `runs/example/`.
2. Weeks later they run the same command.
3. The crawl compares pages as before, asks for each known file only with its validators, and downloads new files.
4. It writes `changes/<time>/` with the new and changed pages and files, and `changes.json` lists each one.
5. Their import reads `changes.json` and copies only the new and changed files.

## Requirements

### R1 (P0): `--save-files` saves same-site files under `files/`
- Given `--save-files`, when the pages are crawled, then every same-site URL a saved page links to (`a`, `area`) or loads (`img`, `source`, `video`, `audio`, `link`) with an image, media, or document extension is downloaded to `files/<url path>`.
- Given a file on another host, or a redirect to one, then it is not downloaded.
- Given a path `robots.txt` disallows, then it is not requested.
- Given a file larger than `--max-file-mb`, then it is recorded as `too-large` and not saved.
- Then `manifest.json` lists each file with its status, outcome, size, SHA-256, `ETag`, and `Last-Modified`, and the report's status table counts them.
- No page is saved under `files/`. A page at `/files` saves to `files_/index.html`.

### R2 (P0): A second crawl downloads only new and changed files
- Given a file the earlier crawl saved with an `ETag` or `Last-Modified`, then the request sends `If-None-Match` or `If-Modified-Since`, and a 304 keeps the saved copy.
- Given a file the earlier crawl saved with neither, then it is kept without a request.
- Given a download with the same SHA-256 as the saved copy, then the file is not rewritten.
- Given both crawls used `--save-files`, then `changes.json` lists new, changed, and removed files under `savedFiles`, with a reason for each removed file, and the new and changed files are copied to the changes folder at the same path.
- Given the earlier crawl did not use `--save-files`, then files are not compared, and the CLI says so.
- A removed file stays on disk.

### R3 (P0): `--strip-param` folds sort copies into one page
- Given `--strip-param order`, then the `order` parameter is removed from every link, the start URL, sitemap entries, and earlier pages before they are queued.
- Given an earlier crawl saved a page under a URL with a stripped parameter, then that page is not reported as removed.
- The option repeats, and the manifest records the parameters.

## Constraints
- Requests to other hosts: none added.
- Politeness: file downloads use the crawl's workers, delay, and `robots.txt` rules.
- Paths: every saved file path comes from `fileUrlToPath`, which keeps writes inside `files/`. A file path from the earlier manifest is used only when it is safe and under `files/`. Tests cover a path that tries to escape.
- Disk: the copies in the changes folder are clones where the disk supports them, so they take no extra space.
- The repo is public. Tests use local fixtures and never name a crawled site.

## Decisions
- 2026-11-21: The project owner asked for the crawler to store everything from a site and add only what changed on later runs. File saving is opt-in, so the default crawl stays record-only, as `prds/incremental-crawl.md` decided.
- 2026-11-21: A known file with no validators is kept without a request. Shop and CMS image URLs change when the image changes, and downloading thousands of images on every crawl costs the site more than a missed edit costs the import.
- 2026-11-21: Stripped parameters are removed, not used to skip URLs. `/list?order=name&page=2` still leads to page 2 of the list.
