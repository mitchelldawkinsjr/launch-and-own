# Launch & Own — skill reference

Facts for agents. Prefer this file over guessing product limits.

## Hosted browser

- Origin: `https://onboard.360web.cloud`
- Promise: Describe it. Launch it. Own it.
- Customer owns: private GitHub repository + Cloudflare Pages project after **explicit approval**
- Launch & Own owns: orchestration, exact preview, durable job verification — not the site subscription

## GitHub App (customer account)

- Customers must **install** the Launch & Own GitHub App on their **personal** account (Repository creation + Contents). OAuth authorize alone is not enough to create repos.
- Cloudflare’s **Workers & Pages** GitHub App is separate and may need access to each new private site repository for builds.

## One-page product themes (manual editor)

Allowed theme values for the hosted one-page renderer: `ocean`, `forest`, `sunset`, `graphite`.

## ZIP / static upload constraints

Mirrored from `onboarding/website-zip.mjs` (keep in sync when that module changes):

| Limit | Value |
| --- | --- |
| Archive size | ≤ 6 MiB (`MAX_ZIP_BYTES`) |
| Extracted site | ≤ 8 MiB (`MAX_SITE_BYTES`) |
| Single file | ≤ 2 MiB (`MAX_FILE_BYTES`) |
| File count | ≤ 128 (`MAX_SITE_FILES`) |
| Homepage | `index.html` at ZIP root **or** inside exactly one build folder |

**Allowed:** regular static files with known extensions (html, css, js/mjs, images, fonts, common media, json/txt/svg/pdf, etc.).

**Rejected examples:** path traversal (`../`), absolute paths, backslashes, `.git/`, `_worker.js`, `functions/`, Wrangler configs, `_headers` / `_redirects` / `_routes.json`, PHP and other non-static types, encrypted ZIP entries, symlinks, duplicate case-insensitive paths.

**Ignored noise:** some macOS metadata (e.g. `__MACOSX`, `.DS_Store`) may be skipped; do not rely on shipping those files.

**Production note:** ZIP onboarding code may be merged while **hosted production ZIP** remains gated (#45). Always state uncertainty if the live UI does not show an upload control.

## Launch job statuses (truthful language only)

| Status | Say |
| --- | --- |
| `preview` | Exact preview ready; not published |
| `queued` | Launch accepted; resources not verified live |
| `pending_deployment` | Approved; waiting on Pages build/verify |
| `needs_reauthorization` | Paused — reconnect and reapprove; do not duplicate |
| `failed` | Paused/failed — use history + error code; no fake success |
| `live` | Only when commit + public HTML verification succeeded |

## Future surfaces (do not simulate as live)

- Shared MCP/API tools and AI-client linking (#43)
- Hosted ZIP activation (#45)
- In-product update editor / PR flow (#31)
- Permanent owned-site discovery UI (#39)
- Public ChatGPT plugin / Claude connector listings without owner approval

## Local prep helpers in this repo (developers)

- `npm run demo:export` / `npm run demo:serve` — local preview of example JSON sites
- `npm run qa:rehearse` — offline localhost SHA rehearsal (not a live launch)
