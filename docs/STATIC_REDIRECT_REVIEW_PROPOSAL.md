# Static redirects review proposal — Issue #88

**Implementing model: GPT-6 (OpenAI), Agent 2.** Review-only code; not an active redirect on the hosted website. Workstream Domain #2 owns Cloudflare DNS, live rules, mailing and the actual approval/execution window; Sol #83 coordinates integration.

## Why this exists

The `/site-options` page introduced in PR #132 stores exact, digest-bound redirect intentions. It does **not** create any redirect. Cloudflare Pages accepts a file called `_redirects` within the static output directory, for example `public/_redirects`. A simple permanent redirect is one line:

```text
/old-services /services/ 301
```

See [Cloudflare Pages Redirects](https://developers.cloudflare.com/pages/configuration/redirects/). The `_redirects` file does **not** apply to responses handled by Pages Functions, so a generic Page Rule or dynamic site cannot be equated with this static artifact.

## Implemented: read-only review proposal

`site/redirect-review-proposal.mjs` exports `buildStaticRedirectReviewProposal`. It consumes a **server-read, validated stored redirect request**, the current owner/site identities, fresh owner-account/Pages-domain evidence, and a read-only pinned Git main/commit/recursive tree. Its current authorization callback must succeed before and after the asynchronous SHA-256 computations.

For a managed, generated one-page site, the only eligible redirect destination is the existing `/` route. For a managed generated four-page site, destinations are limited to `/`, `/about/`, `/services/` or `/contact/`. It refuses to redirect away from a known canonical page, and blocks security/worker URLs, dot segments, malformed paths, potential external destinations, extra unmanaged HTML, existing `_redirects`, symlinks, Pages Functions, `_worker.js`, `_routes.json`, truncated Git trees, stale main, cross-tenant requests, and invalid/stale domain evidence.

The proposal creates **only** a reviewable new `public/_redirects` artifact: exact proposed UTF-8 bytes, SHA-256 content fingerprint and an independent proposal SHA-256 binding the stored opt-in, owner, repo ID, Pages project, base Git SHA, recursive tree SHA and origin. No original HTML or other file is edited.

The return value explicitly sets `readyForProviderWrite:false` and `publicationVerified:false`. A later publisher must show the exact file and separate proposal digest to the site owner, record **new approval**, revalidate pinned Git resource identities and source bytes, create an owner-reviewed Git PR, wait for owner merge, and verify the production URL returns the expected 301 and destination. **The existing stored checkbox is not authorization to publish.**

## Explicit exclusions

- `www`/apex mode: **manual-review-required**. `wwwMode=apex_to_www` or `www_to_apex` requires separate Domain DNS/TLS/redirect policy and both hostnames to be verified. A Pages `_redirects` path rule cannot by itself create DNS or host-level apex→www routing.
- Imported ZIPs, customer-authored files and custom sites: **manual-review-required**, no automatic file overwrite.
- Pages Functions or Worker-handled routes: blocked because Pages `_redirects` would not apply there.
- Existing Pages `_redirects` file: blocked; never silently replace someone else's rules.
- Cloudflare Rules API / paid Page Rules / bulk redirects / WAF: **not requested** and not activated.
- Contact forms and outgoing email remain separately controlled by #89 and the domain/email workstream.

## Operator release checklist

1. Obtain the stored redirect review via the authenticated D1 validator `readOwnedStoredOptionApproval` and require the current GitHub+Cloudflare owner session. Never trust a browser-supplied review object.
2. Fetch the current exact owner GitHub `main`, immutable commit and full recursive tree; verify repo/project ownership and bind `expectedBaseSha`.
3. Obtain fresh Cloudflare Pages custom domain active/TLS evidence for the **same hostname and Pages project**. Do not infer from user-entered text or from a domain request alone.
4. Call `buildStaticRedirectReviewProposal` with `assertCurrentAuthorization` that independently rechecks session/owner/tenant/revocation. Review the returned file bytes and proposal digest.
5. Use a **future** separately approved Git PR executor with new owner approval and a no-replace create of `public/_redirects` against unchanged `main` and tree. Re-run the preflight immediately before the write.
6. Owner merges PR; record public HTTP 301, exact `Location`, final Git commit/Pages deployment and rollback path. Do not mark it live from plan output alone.

Unit tests cover generated one/four-page plans, deterministic bytes, changed digests, ZIP/custom rejection, wrong tenant, stale tree, missing domain evidence, unsafe paths, Functions and existing-file collisions, revoked current authorization and mutation during review. Run `node --test site/redirect-review-proposal.test.mjs` or the product CI suite.

There are **no live customer redirects or provider changes** in this proposal. Independent external customer acceptance #21 is still a future release condition.
