# Imported-site editing contracts (#165 M0)

**Status: DRAFT, pending owner approval.** Prepared by Claude Code (Claude Opus 5.5, `claude-opus-5-5`). No code implements these contracts yet. Nothing here changes release status; `distribution/release-matrix.json` stays authoritative.

These are the shared interfaces that let WS1 (inventory), WS2 (edit engine), WS3 (preview and PR) and WS6 (UI) work in parallel without editing each other's code. Version every payload (`v: 1`). A breaking change needs a new version and a note in #165.

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

```jsonc
{
  "v": 1,
  "repositoryId": 123456789,            // GitHub numeric id, not name
  "baseCommitSha": "<40 hex>",
  "root": "public/",
  "classification": "static" | "static_multipage" | "compiled_bundle" | "source_project" | "unsupported",
  "reasons": ["has_index_html", "minified_js_bundle", ...],   // codes from §4
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
- `source_project` and `unsupported` sites get no editable files. The UI shows the reasons.

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

Validation (all must pass, otherwise reject with a §4 code and no partial apply):
1. `v`, `repositoryId` and `baseCommitSha` match the current inventory.
2. Every `path` is in the inventory, its `kind` is in that file's `editable` list, and `expectedBlobSha` matches.
3. `find` occurs exactly once (`ambiguous_match` if more, `no_match` if none).
4. Limits: ≤ 10 edits, ≤ 5 files, `find`/`replace` ≤ 2,000 chars each, resulting file ≤ 2 MiB.
5. Kind-specific checks: `link` must stay `https:`, `mailto:` or a relative path; `css_color` must be a valid CSS color and the replacement must also be a color; `text`/`business_info` must not add `<`, `>` or attribute syntax.
6. After applying, HTML still parses, and every file not named in `edits` is byte-identical.

## 3. Preview and approval binding (WS3 → WS6)

```jsonc
{
  "v": 1,
  "proposalDigest": "<sha256 of canonical JSON of the validated proposal>",
  "repositoryId": 123456789,
  "ownerGithubUserId": 987,
  "baseCommitSha": "<40 hex>",
  "changed": [ { "path": "public/index.html", "beforeBlobSha": "<40 hex>", "afterSha256": "<64 hex>" } ],
  "artifactDigest": "<64 hex>",          // manifestDigest of the full proposed public/ tree
  "previewUrl": "<isolated preview origin, ticketed, expires with session>",
  "expiresAt": 1764000000
}
```

Rules:
- The preview serves exactly the files in `artifactDigest`, on the separate preview origin, with no credentials. Cloudflare Pages preview builds stay off (`docs/PAGES_PR_PREVIEW_SAFETY.md`).
- Approval is a CSRF-protected owner POST carrying `proposalDigest` + `artifactDigest`. The server recomputes both, checks owner, repo ID, current `main` SHA = `baseCommitSha` and expiry, and fails closed with `stale_base` / `approval_mismatch` / `expired`.
- After approval: deterministic branch `launch-and-own/edit-<first 20 hex of sha256(baseCommitSha:artifactDigest)>`, one multi-file commit, one PR, idempotent on retry (reuse after verifying with `hasApprovedUpdateHead`). Never merge.
- "Live" requires the merged commit SHA to equal the production deployment's commit, plus a fetch of the live files matching `afterSha256`.

## 4. Status and failure vocabulary (all workstreams)

Status: `draft` → `previewed` → `approved` → `pr_open` → `merged` → `deploying` → `live`, plus terminal `rejected`, `failed`, `expired`, `needs_reauthorization`.

Reason and failure codes (UI maps each to plain language; codes are stable):

| Code | Meaning |
| --- | --- |
| `has_index_html` | Static site root found |
| `minified_js_bundle` | Generated/minified JS present; JS is read-only |
| `source_project` | `package.json` / framework config without built output |
| `unsupported_file_type` | Outside `isSitePath` |
| `config_file` | CI, auth, hosting or dependency config; read-only |
| `no_match` / `ambiguous_match` | `find` occurs 0 or more than 1 times |
| `kind_not_allowed` | Edit kind not in the file's `editable` list |
| `limit_exceeded` | Edit, file or size limit exceeded |
| `invalid_output` | Model output failed schema validation |
| `unrelated_change` | A file not named in the proposal changed |
| `stale_base` | `main` moved after the inventory or preview |
| `approval_mismatch` | Digest, owner or repository mismatch |
| `expired` | Preview or approval past `expiresAt` |
| `quota_exhausted` | AI usage guard hit |
| `deploy_unverified` | Merged but the live revision or files do not match yet |

## 5. Fixtures (shared)

`fixtures/imported-sites/<name>/` (new top-level folder; tests stay next to their modules) holds a `public/` tree plus `expected-inventory.json`. Minimum set: `static-single`, `static-multipage`, `compiled-vite-dist`, `source-react-vite` (must classify `source_project`), `ambiguous-text` (duplicate strings), `hostile-content` (prompt-injection text in HTML comments). The corpus agent (child issue D) adds real-export samples here, license-clean and without personal data.

## Open questions for the owner

1. Is the ≤ 10 edits / ≤ 5 files limit right for M1?
2. Should `css_color` edits in M1 be limited to CSS custom properties (`--name: value`) to reduce risk?
3. Should approval expiry match the existing 15-minute site-update review lifetime?
