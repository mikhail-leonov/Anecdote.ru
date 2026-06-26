# Ruero Image Scraper

A standalone, restartable utility that downloads full-resolution images from a
**paginated website**. It walks the listing pages, opens each image-bearing
post, finds the highest-resolution version of every image, and saves it under
`data/images/` — skipping thumbnails, avatars, icons, ads and other non-content
graphics.

There is **no database**. All durable state lives in JSON files under `data/`
(managed by the `src/db/` layer), so the scraper can be stopped at any time and
resumed later without re-downloading anything.

The code keeps the project's original layered layout (`config` / `controllers`
/ `services` / `models` / `db` / `utils` / `views`) so it stays familiar.

---

## Project structure

```
ruero/
├── package.json
├── .env.example                  copy to .env to override config via environment
├── .gitignore
├── README.md
├── public/                       (kept from the original scaffold)
│   ├── css/app.css
│   └── js/
│       ├── app.js
│       └── lng/{en,ru}.js
├── src/
│   ├── index.js                  executable entry point (parses CLI, runs)
│   ├── config/
│   │   └── index.js              dotenv-driven settings + CSS selectors
│   ├── controllers/
│   │   └── scrapeController.js    builds config, constructs & runs the scraper
│   ├── services/
│   │   ├── scraper.js            crawl orchestrator
│   │   ├── pagination.js         finds the next listing page
│   │   ├── postParser.js         finds image posts (skips ads / text-only)
│   │   ├── imageFinder.js        discovers highest-res images on a post page
│   │   ├── downloader.js         streams to disk, hashes, retries, size-checks
│   │   └── duplicateChecker.js   URL / filename / SHA-256 de-duplication
│   ├── models/
│   │   └── imageRecord.js        shape of a persisted image record
│   ├── db/
│   │   └── jsonStore.js          JSON-file persistence layer (replaces SQL)
│   ├── utils/
│   │   ├── index.js              shared helpers (fetch, retry, rate-limit, URL…)
│   │   └── logger.js             file + console logging and statistics
│   ├── routes/                   (kept; unused — CLI tool has no HTTP routes)
│   ├── sql/
│   │   └── schema.sql            (kept; empty — no database is used)
│   └── views/                    (kept from the original scaffold)
│       ├── index.twig
│       ├── layout.twig
│       └── partials/header.twig
└── data/
    ├── images/                   downloaded files
    ├── logs/                     scrape-<timestamp>.log
    ├── downloaded-images.json    saved images: url, sha256, filename, bytes…
    ├── visited-pages.json        processed pages + next-page pointer (resume)
    └── metadata.json             last-run snapshot (stats, timestamp)
```

> Layer mapping: the `controllers` layer wires a run, `services` hold the crawl
> logic, `db` is the JSON persistence layer (there is no SQL database), `models`
> defines the stored record shape, and `config`/`utils` are unchanged in spirit
> from the original scaffold. `routes`, `sql` and `views` are retained only to
> preserve the original structure and are not used by the CLI scraper.

---

## Highlights

- **Pagination crawling** — follows the site's "next" link, with a configurable
  URL-pattern fallback (`/page/{n}/`). Stops automatically at the last page.
- **Full-resolution discovery** — reads full-size `<a>` links, `<img>`
  `src`/`srcset`/lazy-load attributes and `og:image`; upgrades size-suffixed
  thumbnails (`photo-300x200.jpg` → `photo.jpg`).
- **Smart filtering** — rejects images below configurable width/height/file-size
  thresholds and anything matching a URL blocklist (thumb, avatar, icon, logo,
  sprite, pixel, ad…). Dimensions are probed via a tiny ranged request, so small
  images are rejected *before* a full download.
- **Formats** — jpg, jpeg, png, webp, gif (incl. animated). Saved **exactly as
  served**; no format conversion.
- **De-duplication** — by normalized URL, by filename, and by SHA-256 of the
  bytes (same image from different URLs).
- **Resumable** — visited pages and downloaded images are persisted after every
  page; a re-run continues where it left off.
- **Resilient** — per-request timeout, retries with exponential backoff, rate
  limiting, graceful HTTP-error handling. One bad page or image never crashes
  the run.
- **Graceful shutdown** — `Ctrl+C` finishes in-flight downloads, flushes state,
  prints a summary, and exits.
- **Dry-run** and **CLI overrides** for every key setting.

---

## Requirements

- **Node.js 18.17+** (uses global `fetch`, `node:util` `parseArgs`,
  `stream/promises`). Latest LTS recommended.

The project uses ES modules (the original `src/config` used CommonJS; everything
is now ESM because one dependency, `p-limit` v5, is ESM-only). The dotenv-based
config convention is preserved.

---

## Install

```bash
npm install
```

| Package | Why |
|---|---|
| `cheerio` | Fast server-side HTML parsing |
| `probe-image-size` | Read image dimensions from the first few bytes |
| `p-limit` | Bounded download concurrency |
| `dotenv` | `.env` configuration (as in the original scaffold) |

---

## Quick start

1. `cp .env.example .env` and set `START_URL` (and selectors if needed), **or**
   edit `src/config/index.js` directly.
2. Preview without downloading:
   ```bash
   npm run dry-run
   ```
3. Run for real:
   ```bash
   npm start
   ```

Images land in `data/images/`; logs in `data/logs/`.

---

## Configuration

All settings live in **`src/config/index.js`** and can be overridden by
environment variables (see `.env.example`) or CLI flags. Most-edited values:

| Setting | Env var | Meaning |
|---|---|---|
| Start URL | `START_URL` | First listing page |
| Max pages | `MAX_PAGES` | Stop after N pages (`0` = unlimited) |
| Min width/height | `MIN_WIDTH` / `MIN_HEIGHT` | Minimum image dimensions (px) |
| Min file size | `MIN_BYTES` | Minimum image size in bytes |
| Delay | `REQUEST_DELAY_MS` | Minimum gap between requests |
| Timeout | `REQUEST_TIMEOUT_MS` | Per-request timeout |
| Retries | `MAX_RETRIES` | Retry attempts per request |
| Concurrency | `DOWNLOAD_CONCURRENCY` | Parallel downloads |
| User agent | `USER_AGENT` | Request UA header |
| Output dir | `OUTPUT_DIR` | Base of `data/` |
| Selectors | `SEL_*` | Per-site CSS selectors |

### Retargeting another site

Usually only the start URL and `selectors` change. Edit them in
`src/config/index.js` (or via `SEL_*` env vars):

```js
selectors: {
  post: '.card',                 // a post container on the listing page
  postLink: 'a.card__link',      // link to the post page
  postThumbnail: 'img',          // used only to detect "has image"
  nextPage: 'a.pagination-next', // the next-page link
  postContent: '.gallery',       // search scope on the post page
  image: 'img',
  imageLink: 'a',
  adContainer: '.ad, .sponsored',
}
```

---

## Command-line overrides

CLI flags take precedence over `.env` and `src/config`:

```bash
node src/index.js \
  --start-url https://example.com/ \
  --max-pages 25 --concurrency 6 --delay 800 \
  --min-width 500 --min-height 500 --min-bytes 30000 \
  --output data --dry-run
```

`node src/index.js --help` lists every flag.

---

## Content types & encoding (pejnya.net)

This build targets **pejnya.net** and handles three content types:

- **Photo galleries** — opened via `content/photo.php?news=…`; all images saved
  (single image flat, multiple images in a per-title subfolder).
- **Videos** — `.mp4/.webm/.m4v/.mov/.ogv` are discovered (incl. `<video>`/`<source>`)
  and downloaded exactly like images, into `data/images/`.
- **Anecdotes** — text-only joke posts are saved as individual `.txt` files under
  `data/anecdotes/`, de-duplicated by a hash of the text.

**Anecdotes-only mode (default):** `ANECDOTES_ONLY=true` makes the scraper save
ONLY anecdotes and skip all photo/video downloads. Set `ANECDOTES_ONLY=false`
to also download images and videos. In anecdotes-only mode the incremental
early-stop counts anecdotes, so media-only pages don't end the crawl early.

Pages are **windows-1251** encoded; the scraper detects the charset (HTTP header or
`<meta>`) and decodes via `iconv-lite`, so Cyrillic titles/anecdotes are correct.
Pagination is the query-string pattern `/index.php?page={n}`.

> The CSS selectors in `src/config/index.js` are **confirmed against pejnya's**
> real markup (2-row `<table>` posts: header `td.txt-main[bgcolor="#EAEAEA"]`,
> content `td.txt-main[bgcolor="#ffffff"]`). Photo galleries open
> `content/photo.php?news=…`; videos open `video_prikol_big.php?news=…`.
>
> One unverified spot: the video page's own markup. The scraper opens each
> `video_prikol_big.php` page and grabs any `<video>/<source>` or direct
> `.mp4` link it finds. If those pages use a JS player with no direct file,
> the video URL needs a small selector tweak — send that page's HTML.

## File naming

By default downloaded files are named after the **post title** plus the image
index: `image_3.jpg` from post "Isabella D : яркая белизна" is saved as
`Isabella D - яркая белизна_3.jpg`. The index is taken from the source
filename's trailing number when present, otherwise a running counter. Cyrillic
and spaces are kept; characters illegal on Windows (`<>:"/\|?*`) are replaced
with `-`. Set `NAME_BY_POST_TITLE=false` to keep the original source filenames
instead. Duplicate names get `_2`, `_3`… appended.

**Single vs series:** a post with one image is saved flat in `data/images/`. A post with multiple images (a gallery/series) gets its own subfolder named after the post title, e.g.:

```
data/images/
├── Isabella D - яркая белизна/
│   ├── Isabella D - яркая белизна_0.jpg
│   ├── Isabella D - яркая белизна_1.jpg
│   └── Isabella D - яркая белизна_2.jpg
└── Сеточное_5.jpg            # single-image post stays flat
```

## Incremental vs full crawl

This site **prepends new posts daily**, so page numbers are not stable (today's
`/page/2/` becomes tomorrow's `/page/3/`). Resume therefore keys on the stable
**post URL**, recorded in `data/visited-posts.json` — never on the page number.

- **`incremental` (default)** — walks pages from the top, skips posts already
  downloaded (without even fetching their post page), and **stops after
  `STOP_AFTER_KNOWN_PAGES` consecutive pages that contain no new posts** (i.e.
  you've caught up). This makes a daily run fast: it fetches only the first few
  pages until it reaches content it already has.
- **`full`** — walks every page to the very end. Use this once for the initial
  complete mirror. Already-downloaded posts are still skipped, but the crawl
  never early-stops.

```bash
# initial complete mirror (all pages)
node src/index.js --full

# daily incremental top-up (default mode) — only new posts
node src/index.js

# tune how many all-known pages to tolerate before stopping
node src/index.js --stop-after-known 3
```

Galleries: when a post's full set lives on its post page (e.g. a teaser shows
`image_0` with "see the rest in the gallery"), the scraper still gets everything
— it always opens the post page and downloads every qualifying image found
under `selectors.postContent`.

---

## How it works


```
load JSON state
  └─ for each listing page (follow pagination):
       fetch page → parse posts (skip ads & text-only)
         └─ for each image post:
              fetch post page → find images (highest-res) → filter
                └─ download (concurrent, dedup, hash, size-check)
       persist visited-pages.json + downloaded-images.json
  until: no next page · maxPages reached · empty page · Ctrl+C
```

`downloaded-images.json` and `visited-pages.json` make resume work — keep them
between runs. To start fresh, delete the contents of `data/`.

---

## Logging & statistics

The log records pages visited, posts processed, images
discovered/downloaded/skipped/duplicated, failures and retries. A progress line
prints periodically and a full summary prints on completion or shutdown:

```
Pages visited:      42
Posts processed:    318
Images discovered:  512
Images downloaded:  474
Duplicates skipped: 28
Other skips:        10
Failures:           0
Retries:            6
Data downloaded:    1.9 GB
```

---

## Notes

- **Stopping** — last page (no next link / 404), `maxPages`, or an empty page.
- **Politeness** — `REQUEST_DELAY_MS` throttles all requests; downloads are also
  capped by `DOWNLOAD_CONCURRENCY`. Check the target's terms and `robots.txt`,
  and use a reasonable delay and User-Agent before scraping at scale.
- **Originals** — animated GIFs and full-size files are saved byte-for-byte.

## License

MIT.
"# Anecdote.ru" 
