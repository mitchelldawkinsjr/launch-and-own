# Imported-site editing contracts (#165 M0)

**Status: APPROVED, revision 2.** Owner approval recorded on #171 item 7, 2026-11-25. Prepared by Claude Code (Claude Opus 5.5, `claude-opus-5-5`). No code implements these contracts yet. Nothing here changes release status; `distribution/release-matrix.json` stays authoritative.

Revision 2 addresses the coordinator review and the WS5 security review on #176, plus findings from the corpus pilot (#169) and the provisional fixture schema (#172 comment 7153907192, used by fixture PR #177). See [Changes in revision 2](#changes-in-revision-2).

These are the shared interfaces that let WS1 (inventory), WS2 (edit engine), WS3 (preview and PR) and WS6 (UI) work in parallel without editing each other's code. Every payload carries `v: 1`. A breaking change now needs a new version, a note in #165 and owner approval.

## 0. Baseline this builds on

| Existing piece | Reused for |
| --- | --- |
| `onboarding/website-zip.mjs` (`extractWebsiteZip`, `isSitePath`, size/file limits) | Import validation. Limits: 6 MiB ZIP, 8 MiB site, 2 MiB/file, 128 files |
| `pipeline/provision-imported-site.mjs` | Imported files live under `public/` in the customer repo |
| `onboarding/zip-artifacts.mjs` (`manifestDigest = sha256(JSON.stringify([1, files]))`) | Exact artifact identity |
| `onboarding/zip-preview-worker.mjs` + `zip-preview-access.mjs` | Isolated preview origin with no credentials |
| `pipeline/propose-site-update.mjs` (`expectedBaseCommitSha`, `approvedHtmlSha256`, `expectedRepositoryId`, `hasApprovedUpdateHead`) | Approval-binding pattern, deterministic branch name, PR-only |
| `pipeline/managed-site-tree-preflight.mjs` | Refuse symlinks, submodules and changed files in the tree |

Imported sites never go through `site/render-site.mjs` or `site.json`.

## 1. Site inventory (WS1 → WS2, WS6)

Pure function of the repository tree at one commit. Recomputed from the current Git revision on every request and never cached across commits.

**Classify the uploaded root**, meaning the tree that was imported to `public/`. Do not infer the classification from the tool that made it or from a different tree in an upstream repository. A built `dist/` is not a source project just because the upstream repo also has `package.json`.

Importing, being ready to serve, and being editable are **three separate assessments**. Passing the ZIP importer does not prove that a site works in a browser or can be edited safely (#169 pilot: an accepted root `index.html` with a bare React import, and a Bolt `dist` referencing missing local files).

```jsonc
{
  "v": 1,
  "repositoryId": 123456789,            // GitHub numeric id, not name
  "baseCommitSha": "<40 hex>",
  "root": "public/",
  "classification": "static" | "static_multipage" | "compiled_bundle" | "source_project" | "unsupported",
  "importable": true,                   // passed extractWebsiteZip rules
  "serveReady": true,                   // static dependency check (below) found nothing missing
  "reasons": ["has_index_html", ...],   // codes from §4, sorted, unique
  "files": [
    {
      "path": "public/index.html",
      "blobSha": "<40 hex>",            // git blob sha at baseCommitSha
      "bytes": 10422,
      "type": "html" | "css" | "js" | "image" | "font" | "other",
      "editable": ["text", "link", "business_info", "css_color"],   // [] = read-only
      "readOnlyReason": null | "<code from §4>"
    }
  ]
}
```

Rules:
- `editable` lists only the edit kinds from §2 that the engine can safely apply to that file.
- JS, minified files, generated bundles, CI, auth and hosting config are always `editable: []`.
- `source_project` and `unsupported` sites get no editable files, and the UI shows the reasons.
- A static dependency check resolves every local `href`/`src` in HTML and every `url()`/`@import` in CSS against the tree. A missing target adds `missing_local_dependency` and sets `serveReady: false`. A JS bare module specifier (for example `import React from "react"`) adds `bare_import` and classifies the site `source_project`. Absolute external URLs add `external_dependency`, which is informational and does not block.
- Text rendered only by JavaScript is not an edit target; edits apply only to static HTML/CSS content.

## 2. Edit proposal (WS2 → WS3, WS6)

Model output is untrusted. The model returns **only** this shape. Deterministic code validates it and the model never calls providers.

```jsonc
{
  "v": 1,
  "requestId": "<uuid>",
  "repositoryId": 123456789,
  "baseCommitSha": "<40 hex>",
  "summary": "Update Saturday hours",                 // ≤ 200 chars, plain text
  "edits": [
    {
      "kind": "text" | "link" | "business_info" | "css_color",
      "path": "public/index.html",
      "expectedBlobSha": "<40 hex>",                  // must equal inventory blobSha
      "find": "Saturday: 9 AM–2 PM",                  // must occur exactly once in the file
      "replace": "Saturday: 10 AM–4 PM"
    }
  ]
}
```

### 2.1 Validation

All checks must pass, otherwise reject the whole proposal with a §4 code. There is never a partial apply.
1. `v`, `repositoryId` and `baseCommitSha` match the current inventory.
2. Every `path` is in the inventory, its `kind` is in that file's `editable` list, and `expectedBlobSha` matches.
3. `find` occurs exactly once in the file's UTF-8 text (`ambiguous_match` if more, `no_match` if none). Counting is per file.
4. Limits: ≤ 10 edits, ≤ 5 files, `find`/`replace` ≤ 2,000 chars each, resulting file ≤ 2 MiB (owner-approved for M1).
5. **Context check (parsed, not textual).** Parse the file and locate the single `find` span. The span must sit entirely inside the context allowed for its kind, or the edit is rejected with `context_not_allowed`:

| Kind | Allowed context | Never allowed |
| --- | --- | --- |
| `text`, `business_info` | One HTML text node | Inside `<script>`, `<style>`, `<template>`, `<textarea>`, comments, attribute values, tag syntax, or across element boundaries |
| `link` | The **whole** value of an `href` attribute on an `<a>` element (`find` equals the full current value) | `src`, `action`, `formaction`, `srcdoc`, `style`, event handlers, `<base>`, `<link>`, `<meta http-equiv>` |
| `css_color` | The **whole** value of one parsed CSS declaration, in a `.css` file or a `<style>` element. M1: custom properties only (`--name: <color>`), owner-approved | Selectors, at-rules, `url()`, comments, inline `style` attributes |

6. **Replacement check.** `text`/`business_info` replacements are plain text and are HTML-escaped on apply; raw `<`, `>` or `&` in `replace` is escaped, not interpreted. `link` replacements must be an absolute `https:` URL, a `mailto:` or `tel:` URL, or a relative path that resolves inside `public/`. `css_color` replacements must parse as exactly one CSS color, and the old value must also have parsed as a color.
7. **Overlap and ordering.** Resolve every span against the **original** file content. If two edits in one file overlap or touch the same span, reject with `overlapping_edits`. Apply edits to each file in descending span-offset order so offsets stay valid. The order of the `edits` array never changes the result.
8. **After apply:** HTML still parses, the context check still holds at the new spans, the static dependency check finds no new `missing_local_dependency`, and every file not named in `edits` is byte-identical (`unrelated_change` otherwise).

### 2.2 Canonical serialization

All digests use **RFC 8785 JSON Canonicalization Scheme (JCS)** over UTF-8, then SHA-256 as lowercase hex. Before canonicalizing a proposal, sort `edits` by `(path, span start offset in the original file)`. Two proposals that make the same changes in a different array order therefore produce the same `proposalDigest`.

## 3. Preview and approval binding (WS3 → WS6)

```jsonc
{
  "v": 1,
  "approvalId": "<128-bit random, hex>",   // server-generated when the preview is created
  "proposalDigest": "<sha256 of JCS(proposal), see 2.2>",
  "repositoryId": 123456789,
  "owner": { "provider": "github" | "cloudflare_access", "id": "<string>" },
  "baseCommitSha": "<40 hex>",
  "changed": [ { "path": "public/index.html", "beforeBlobSha": "<40 hex>", "afterSha256": "<64 hex>" } ],
  "artifactDigest": "<64 hex>",          // manifestDigest of the full proposed public/ tree
  "previewUrl": "<isolated preview origin, ticketed, expires with session>",
  "expiresAt": 1764000000
}
```

`owner` makes WS3 independent of where it runs: `github` (numeric user id as a string) in the hosted product for M1.5, and `cloudflare_access` (Access `sub`) in the customer-owned assistant for M2. Owner checks compare **provider and id together**.

Rules:
- The preview serves exactly the files in `artifactDigest`, on the separate preview origin, with no credentials. Cloudflare Pages preview builds stay off (`docs/PAGES_PR_PREVIEW_SAFETY.md`).
- **Approval** is a CSRF-protected owner POST carrying `approvalId`, `proposalDigest` and `artifactDigest`. The server recomputes both digests and checks owner, repository ID, expiry, and that current `main` equals `baseCommitSha`. It fails closed with `approval_mismatch`, `expired` or `stale_base`.
- **Single use.** In the same transaction, before any GitHub write, the server marks `approvalId` consumed under a unique constraint. A second POST with the same `approvalId` fails with `approval_consumed`. A replay therefore cannot produce a second commit.
- **Idempotency key** is `(repositoryId, baseCommitSha, artifactDigest)`, recorded with the `approvalId` that first claimed it. A different approval for the same key by the **same owner** returns the existing PR and makes no new commit. Any other owner gets `approval_mismatch`.
- **Re-read the base right before writing.** Check `main` = `baseCommitSha` at approval **and** again immediately before creating the branch ref. Always create the branch from `baseCommitSha`, never from the current head. Branch name: `launch-and-own/edit-<first 20 hex of sha256(baseCommitSha:artifactDigest)>`. One multi-file commit, one PR. On retry, reuse only after `hasApprovedUpdateHead` verifies the head and repository. **Merge only as below.**
- **Approve and publish** (owner decision, 2026-11-26): unless the owner chose *Open a pull request instead*, the server merges **that exact PR** right after creating it, in the same approved request. It re-verifies the PR with the flow's reader first, requires `main` = `baseCommitSha` at merge time (`stale_base` otherwise), and passes the approved head as GitHub's merge `sha`, so a moved head is refused. Any refusal leaves the PR open with code `merge_blocked`. It never retries, force-merges or merges any other PR (`pipeline/merge-approved-pr.mjs`).
- Expiry: 15 minutes, matching the existing site-update review lifetime (owner-approved).
- "Live" requires the merged commit SHA to equal the production deployment's commit, plus a fetch of the live files matching `afterSha256`.

## 4. Status and failure vocabulary (all workstreams)

Status: `draft` → `previewed` → `approved` → `pr_open` → `merged` → `deploying` → `live`, plus terminal `rejected`, `failed`, `expired`, `needs_reauthorization`.

Reason and failure codes (the UI maps each to plain language; codes are stable):

| Code | Stage | Meaning |
| --- | --- | --- |
| `has_index_html` | Inventory | Static site root found |
| `minified_js_bundle` | Inventory | Generated or minified JS present; JS is read-only |
| `source_project` | Inventory | Unbuilt source: `package.json` or framework config without built output, JSX/TSX, or bare imports |
| `bare_import` | Inventory | JS uses a bare module specifier that a browser cannot resolve |
| `missing_local_dependency` | Inventory, after apply | A local `href`/`src`/`url()`/`@import` target is missing |
| `external_dependency` | Inventory | References absolute external URLs (informational) |
| `unsupported_file_type` | Inventory | Outside `isSitePath` |
| `config_file` | Inventory | CI, auth, hosting or dependency config; read-only |
| `no_match` / `ambiguous_match` | Validation | `find` occurs 0 or more than 1 times in the file |
| `kind_not_allowed` | Validation | Edit kind not in the file's `editable` list |
| `context_not_allowed` | Validation | Span is outside the parsed context allowed for its kind (§2.1 step 5) |
| `overlapping_edits` | Validation | Two edits overlap or touch the same span in one file |
| `limit_exceeded` | Validation | Edit, file or size limit exceeded |
| `invalid_output` | Validation | Model output failed schema validation |
| `unrelated_change` | After apply | A file not named in the proposal changed |
| `stale_base` | Approval, pre-write | `main` moved after the inventory or preview |
| `approval_mismatch` | Approval | Digest, owner or repository mismatch |
| `approval_consumed` | Approval | `approvalId` already used |
| `expired` | Approval | Preview or approval past `expiresAt` |
| `merge_blocked` | Publish | GitHub refused the automatic merge (not mergeable, head moved, or a repository rule); the PR stays open for the owner |
| `credentials_revoked` | Any provider call | GitHub token mint or API returned 401, 403 or 404 on the installation; maps to status `needs_reauthorization` |
| `quota_exhausted` | Proposal | AI usage guard hit |
| `deploy_unverified` | Verification | Merged, but the live revision or files do not match yet |

## 5. Fixtures (shared)

`fixtures/imported-sites/<name>/public/` holds the uploaded root, with `expected-inventory.json` next to `public/` (not inside it). Minimum set: `static-single`, `static-multipage`, `compiled-vite-dist`, `source-react-vite` (must classify `source_project`), `ambiguous-text` (duplicate strings; still `static`, the duplicate is an edit-time `ambiguous_match`), `hostile-content` (prompt-injection text in an HTML comment; still `static`, and the comment is data, not an instruction).

`expected-inventory.json` asserts only what the file tree determines. It leaves out `repositoryId`, `baseCommitSha` and `blobSha`, which come from a Git revision read:

```json
{
  "v": 1,
  "classification": "static",
  "importable": true,
  "serveReady": true,
  "reasons": ["has_index_html"],
  "files": [
    { "path": "public/index.html", "bytes": 120, "type": "html", "editable": ["text", "link", "business_info"], "readOnlyReason": null }
  ]
}
```

Fixtures are original or license-clean, contain no personal data, and keep provenance and observed importer results separate from proposed classifier expectations (as in #177). The corpus agent (#169) adds real-export samples here.

## Owner decisions (#171, 2026-11-25)

1. M1 limits: ≤ 10 edits / ≤ 5 files per change.
2. `css_color` edits in M1: CSS custom properties only.
3. Approval expiry: 15 minutes.

4. (2026-11-26) **Approve and publish:** approving merges the exact approved change. *Open a pull request instead* keeps the earlier PR-only behaviour. It applies to hosted imported edits, created-site updates and the customer-owned assistant. Contact-form connection is unchanged (PR only).

Approving the contract does not authorize hosted routes, M1.5, inference, live accounts or deployment. Each needs its own owner go-ahead.

## Changes in revision 2

| Source | Change |
| --- | --- |
| Coordinator review (#176) | RFC 8785 canonical serialization with sorted edits (§2.2); parsed context check per kind (§2.1 step 5); `link` limited to whole `<a href>` values; `css_color` limited to whole parsed declaration values; overlap rejection and order-independent apply (§2.1 step 7); `missing_local_dependency` and `bare_import` codes; idempotency key and collision rule (§3); fixture schema aligned with #172/#177 (§5) |
| WS5 security review (#176) | `owner: {provider, id}` (§3); single-use `approvalId` consumed under a unique constraint before any write, plus `approval_consumed`; `credentials_revoked` code; base re-read immediately before the ref write, with the branch always created from `baseCommitSha` |
| Corpus pilot (#169) | Classify the uploaded root; separate `importable` / `serveReady` / editable assessments; static dependency check; JS-rendered text is not an edit target; `external_dependency` is informational |
| Provisional fixture schema (#172 comment 7153907192) | Adopted as §5 with `importable`/`serveReady` added |
