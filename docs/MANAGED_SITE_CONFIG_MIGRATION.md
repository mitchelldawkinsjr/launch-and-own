# Structured site configuration and reviewed migration (#39, GPT-6)

**Code-only planning foundation. Implementing model: GPT-6. Hosted editor integration awaits owner approval and verified eligibility.**

The customer should be able to reopen a managed website after the 30-day launch history expires, edit the **current** site safely, and avoid reverting earlier merged changes. The existing #98 read-only discovery validates owner/repository/Pages links and reads the SHA-pinned latest `public/index.html`. It does not grant write permission, reconstruct the original launch config, or prove the current public website serves those exact bytes.

This separate pure helper implements a **reviewable config sidecar contract**, not a provider executor. The sidecar lives at `.launch-and-own/site-config.json`, **outside** the `public/` Pages output directory, in the customer's already-private GitHub repository. No new D1 storage, OAuth scope, Cloudflare resource, billing or new hosted endpoint is required for this plan.

## Contract

`pipeline/managed-site-config.mjs` exports:

- `planManagedSiteSidecarMigration({currentSource,sidecarEvidence,candidateSite,eligibilityEvidence,assertGeneratedOnePageEligibility})`: *legacy source without sidecar*. A trusted backend must have fetched the current SHA-pinned GitHub HTML using #98 and independently observed HTTP 404 for the sidecar at **that same commit** and authenticated `siteId`. The sidecar absence evidence must contain `{path,siteId,refCommitSha,exists:false}` and no blob/content digests. It may accept the customer's candidate fields as input **only to generate an unapproved review**. Normalize via the shipped `renderSite` implementation and require a SHA-256 **byte-for-byte match** against the actual current HTML. The plan proposes exactly one new file: the private sidecar; **it does not edit the homepage**. Non-renderer HTML, BOM-prefixed HTML, ZIP imports, custom CSS, templates with changed markup, or modified legacy pages that no longer match the renderer cannot be silently migrated. They need a separately previewed, explicitly human-approved artifact change.
- `planManagedSiteStructuredEdit({currentSource,sidecarEvidence,sidecarRaw,patch,eligibilityEvidence,assertGeneratedOnePageEligibility})`: *a site that already has an approved sidecar*. Load a backend-proven, SHA-pinned, canonical sidecar whose evidence contains `{path,siteId,refCommitSha,exists:true,blobSha,contentSha256}`; **first compare SHA-256 of the exact sidecar bytes against `contentSha256`**, and check its recorded HTML SHA against both the current verified GitHub bytes and the deterministic renderer output. A patch can change only `tagline`, `about`, `services`, `theme` or `contactEmail`. The business name and other untouched values remain preserved. A meaningful edit proposes two **review-only** files: `public/index.html` and `.launch-and-own/site-config.json`. A no-op proposes neither. The next edit after a separately approved merge must re-read the *new current* `main` HTML and sidecar; never reuse the prior launch's `plan_json` or an old edit ticket.

The sidecar is canonical UTF-8 JSON with deterministic field order and a trailing newline:

```json
{
  "schema": "launch-and-own/site-config",
  "version": 1,
  "site": {
    "name": "Example Studio",
    "tagline": "Every detail matters",
    "about": "About the studio.",
    "services": ["Portraits"],
    "theme": "forest",
    "contactEmail": ""
  },
  "htmlSha256": "64-character hex digest of exact current public/index.html bytes"
}
```

The parser rejects unsupported version, duplicate or unknown JSON keys, malformed/corrupt fields, noncanonical serialization and **root/nested key reordering**. Canonical JSON is reconstructed from schema-defined field order rather than the insertion order supplied in an input JSON object. It also rejects sidecar byte digest mismatches, mismatched HTML digests and renderer divergence. No password, token, OAuth credentials, private customer archive or unrelated repo source may be attached.

## Server-verified site eligibility and async review safety

Read-only #98 discovery proves a customer currently owns an eligible-looking private GitHub repository and linked Pages project; its mutable repository description **does not prove historical continuity**, that the repo originated as a generated one-page site, or that the latest tree was not an uploaded ZIP or multi-page artifact. This is why **both planners refuse to run** without:

1. An immutable `eligibilityEvidence` record matching the `currentSource` exactly on `siteId`, `baseCommitSha`, and `homepageGitBlobSha`; plus `sourceKind:'generated'`, `layout:'one-page'`, and `provenance:'pinned_launch_approval'` or `'explicit_owner_adoption'`. A copied marker cannot supply these fields as trusted evidence.
2. A mandatory backend `assertGeneratedOnePageEligibility(frozenIdentity)` callback that independently rechecks the **current authenticated session, selected owner/account, verified repository and Pages immutable IDs, pinned source commit, and authoritative origin/adoption proof**. The callback runs before any content digest and again before returning a plan. It must return literal `true` only while that same eligible owner/site/ref remains authorized. Never accept a client-supplied callback or a boolean supplied by the browser.

All input values (including current SHA-pinned HTML, sidecar evidence/bytes, customer edit patch and eligibility record) are **defensively copied synchronously before the first async digest**. Rechecks refuse detected changes to original objects during asynchronous hashing and authorization. No async step uses live mutated input references. Return codes describe unavailable eligibility or changed input without echoing confidential provider payloads.

A verified ownership *candidate* from #98 with no original pinned launch record must be offered a separate authenticated **owner adoption review**, not silently classified `generated` just because its HTML matches the renderer. Existing ZIP, multi-page and arbitrary custom HTML remain outside the one-page editor until a separate product-specific reviewed migration is built.

## Approval and immutable evidence

Every non-no-op result is **`status:'review_required'`**, `readyForProviderWrite:false`, and `requiresSeparateHumanApproval:true`. It includes a digest of:

- the selected immutable `siteId`;
- the exact original `main` commit, Git blob SHA and **byte-exact** original HTML SHA;
- whether this is sidecar creation or a paired HTML+sidecar update;
- the existing sidecar Git blob SHA **and its exact UTF-8 SHA-256** for paired edits;
- the proposed HTML digest and sidecar digest; and
- the fixed private sidecar path; and
- the provenance type (`pinned_launch_approval` or `explicit_owner_adoption`) confirmed by a backend authorization check.

**A digest is not a signature, consent or session authorization.** Domain's backend must first authenticate/refresh current owner and Cloudflare grants, verify #98's current immutable repository/project ID, bind a short-lived server-authenticated review to that owner/session authorization epoch and approval digest, present exact preview and file changes, require separate human approval, and check the same immutable main SHA and blobs again before proposing a feature branch/PR. Do **not** allow a browser/model to supply its own `currentSource`, sidecar evidence, site reference, expiry, approval flag or grants. `sidecarEvidence` and `sidecarRaw` must be obtained by the backend from GitHub at the exact source commit, **same authenticated site ID**, and within the Free-tier request budget. Present sidecar evidence must include SHA-256 of the exact returned bytes and the Git blob SHA. A correctly shaped object supplied by the browser is **not ownership proof**; the backend must bind it to its server-held current ref and session. This module makes no provider calls itself.

A future executor must create only an owner-approved private GitHub branch and PR, must not modify `main` or Cloudflare directly, must reject stale PR/repo/branch or an existing conflicting sidecar, must handle retry idempotently, and must await manual GitHub merge. Publication still requires a separate canonical production commit + **exact public HTML** verification. No sidecar plan by itself proves historical continuity, ownership, consent, HTTPS, a public deployment or successful merge.

## Compatibility and safe migration behavior

- `renderSite(normalizeSite(...))` is the exact existing one-page renderer; a legacy migration is permitted only when candidate fields reproduce the precise current homepage bytes **and the server has independently verified that the site is an eligible generated one-page site at the exact pinned ref**. If the original site used hand-edited HTML and it cannot reproduce the bytes, report **manual artifact migration required** rather than replacing anything.
- A sidecar exists outside `public` to avoid publishing the config or changing the served homepage during a metadata-only migration. The current Pages build configuration must continue to publish `public/` only; use #98 to verify source and project linkage before any review.
- Subsequent edits read current sidecar state, not original launch history. The tests simulate a merged first update followed by a second patch; untouched headline/about/services survive.
- The parser is intentionally strict about canonical JSON to avoid ambiguity about duplicate keys, unexpected fields, or versioning. An unsupported externally edited sidecar is **not automatically repaired** or overwritten; require a separate exact-source review or manual intervention.
- The API supports only the renderer's generated one-page sites. Uploaded ZIP, multi-page or custom designs need separate reviewed editors; do not falsely promise that their raw HTML is editable form fields.
- The source HTML may contain private/customer content. Never render it unsandboxed on the onboarding origin, log it, put it in public telemetry, or persist it beyond the user's authorized short-lived review. A preview should use the existing isolated/private `no-store` and safe rendering rules, with explicit consent. The canonical JSON is stored only after an approved GitHub PR is manually merged.

## Tests and deployment gate

`pipeline/managed-site-config.test.mjs` covers sidecar-only exact matching, rejection of custom HTML/BOM, exact source digest and SHA pinning, cross-site sidecar absence/presence, sidecar raw-byte digest mismatches, root/nested key order, stale sidecars, malformed/duplicate keys, changed owner-facing fields, mutable async review inputs, generated-one-page eligibility revocation, multi-edit preservation, no-op semantics, separate review requirements, and approval digest binding to original/next bytes, original sidecar content hash, eligibility provenance and site identity.

Run `npm test`, `npm run qa:distribution`, `npm run preflight:onboarding`, Worker syntax check and Workerd/D1 recovery. Sol #83 should review the review/sidecar schema; Domain #2 owns the eventual #97 session and current-ref handoff, #87 customer UI and #30 approved PR executor; #21 independent customer acceptance remains mandatory. No automatic production mutation, provider write, cookie/session schema, or feature-release truth is changed by these files.

Rollback: revert the three new source/test/doc files. There is no new provider/customer or stored data to clean up.
