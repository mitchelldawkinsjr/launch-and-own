# Long-term managed-site inventory: read-only backend foundation (#39)

**Implementation model: GPT-6 (OpenAI). Release status: draft, unmerged, not deployed.**

The existing 30-day D1 launch-job history is not a long-term site catalog. This change discovers current owner-controlled Launch & Own sites directly from the connected providers, and provides the latest immutable GitHub homepage as *untrusted source content* for an eventual customer-approved edit. It never extends 30-day retention, creates a database table, rewrites a site, enables previews/Analytics, or publishes anything.

## Files and integration contract

- `pipeline/owned-site-inventory.mjs`: `discoverOwnedManagedSites({principal,githubAccessToken,cloudflareAccessToken,assertCurrentAuthorization,fetchFn?})` and `readCurrentManagedHomepage({siteId,...same})`.
- `pipeline/owned-site-inventory.test.mjs`: identity, pagination, same-name replacement, different-account, token revocation, latest SHA and untrusted-source tests.
- The expected **trusted backend principal** is `{githubUserId,githubLogin,cloudflareAccountId}`, derived from a live GitHub identity and the currently selected, authorized Cloudflare account. Do not reconstruct it from query params, browser JSON or an AI-generated message.
- `assertCurrentAuthorization(frozenOwnerIdentity)` **must** re-read the current session hash, authorization epoch, selected account and non-revoked provider grants from the backend before and after every provider request. An in-memory boolean does not satisfy production authorization. Denial, loss of credentials or account switching fail closed. The adapter cannot create this callback because it does not own the D1 session schema or Worker route (#2 / Domain).
- Responses contain a bounded `sites` collection with only server-verified immutable owner/repository/Pages IDs, a **128-character-bounded** `managed_<repoId>_<pagesProjectId>` selector, both `branch` and `productionBranch` set to verified `main` for #85/#84 adapter compatibility, current main SHA, a Pages project settings link and a GitHub repository link. No OAuth token, provider error payload, raw repository description, customer email or unverified public/live URL is returned.

## Discovery flow and ownership evidence

1. Read **GitHub GET /user** with the current user token, matching the immutable user ID and login. Read **Cloudflare GET /accounts/{selectedAccount}/pages/projects?page=N&per_page=10** using its current account token. This is scoped to the selected account; an account switch does not reuse a cached result. Cloudflare's current API accepts pagination with `per_page=10` in read-only owner testing. Bounded scan maximum: **10 pages / 100 project records**. Unknown, inconsistent or oversized pagination causes an explicit failure instead of a silently partial inventory.
2. Consider only project names matching `esp-{slug}-site`. Retrieve the precise individual Pages project by name, require the immutable project ID to match the list entry, and read the matching `esp-{slug}` GitHub repository. The repository must be private, owned by the current GitHub user ID/login, have a Launch & Own managed description marker, and use the `main` branch.
3. Require the exact GitHub-linked Pages project source, canonical repo ID and optional reported GitHub `owner_id`, production `main`, no Pages Functions, and the approved static build output. Reuse Sol's merged #84 `matchesApprovedPagesProject` matcher. The result never treats same-name replacement, unrelated Cloudflare account, stale permission or changed GitHub source as an owned site.
4. Read `GET /repos/{owner}/{repo}/branches/main` and report its **current source commit SHA**. The Cloudflare canonical production commit is reported only as *observed metadata*, never as an independently verified public HTML/HTTPS claim. The existing #84 capability projection must receive separately verified, timestamped public evidence before it can say `verified_deployment` or return a verified website URL.
5. Recheck the authorization fence before return. Pagination, provider errors and token-bearing transport exceptions expose only safe error codes.

No launch receipt, cookie, original `plan_json`, approval fingerprint or retained 30-day job is required to discover these sites. No new durable data is stored. Provider API permissions remain governed by the account owner's existing GitHub/Cloudflare grants.

## Current source, legacy sites, and second edits

`readCurrentManagedHomepage` takes an **opaque selector, not an authority**: it rediscovers the selected owner's sites and compares the derived site ID. It fetches `public/index.html` with `?ref=<current full main SHA>`, validates a bounded UTF-8/base64 GitHub blob (max 128 KiB), calculates its SHA-256, and then re-reads the live branch, repository and Pages project. If the revision or immutable owner/project identity moved during the request, it refuses the source rather than building a PR from an obsolete baseline.

It returns an internal-only `html` plus `baseCommitSha`, `homepageHtmlSha256`, and `editMode:'approved_migration_required'`. This **does not** imply the current HTML is editable form fields, or that a GitHub commit alone verifies what the public website serves. Treat HTML as potentially hostile customer content: do not insert it into the trusted onboarding origin, bypass HTML escaping, or persist it past current authorized work. No sidecar is silently invented from the first launch's stored config.

**Still to implement separately under #39:** a reviewed structured source format, a customer-approved, non-destructive sidecar migration PR when a legacy site is encountered; a precise current-source editor whose next edit preserves earlier changes; exact approval digest/base SHA, branch-and-PR updates and final independent canonical SHA/public HTML verification. A missing sidecar is a migration gate, not an excuse to overwrite a managed `main` homepage. ZIP and multi-page sites must not be presented as supported in the initial form editor.

## Dependencies, privacy and release gates

- **#39 backend / this PR:** read-only identification and latest source only. Provider GET calls are bounded, redirect-disabled and fenced before/after await. A selected account with missing permission or ambiguous pagination surfaces an explicit safe error, not zero sites.
- **#2 Domain and #41 shared Worker:** schedule authenticated no-store/CSRF-safe route integration, implement real D1 `assertCurrentAuthorization`, refreshed access token retrieval and expiry/revocation controls. Do not trust caller-provided owner/repo IDs. No Worker or D1 edit in this PR.
- **#83 Sol / #84:** existing merged capability projection can consume the server-derived reference fields (`productionBranch: site.branch`), with separate fresh GitHub/Pages reads and independent timestamped public verification. The source-retrieval path must remain backend-internal.
- **#85 Analytics and #87 dashboard:** Analytics can consume a frozen verified site identity and the live authorization callback **only once** #39's route-level trust contract is implemented; the current history-only dashboard remains a 30-day view until then. No automatic Analytics beacon/activation.
- **#30, #21:** editing beyond original history and independent customer acceptance remain open. No site preview enablement, customer data change, billing/OAuth/DNS change, merge or hosted rollout is authorized by this code.

## QA and rollback

Run `npm test`, `npm run qa:distribution`, `npm run preflight:onboarding`, Worker syntax validation and the Workerd/D1 recovery workflow. The focused suite covers genuine owner discovery without any history record, wrong accounts, GitHub user mismatch, immutable repo/project replacements, private/managed markers, optional reported `owner_id`, Pages build policy, bounded pagination, missing grant/session epoch, token-safe provider failure, selector forgery, current content hash, branch drift, changed repository identity and malformed/oversized source.

Rollback is a normal Git revert of these standalone source, test and doc additions. No persistent inventory state, new permission or provider write exists to undo. A green mock or owner-only read is **not** independent #21 beta acceptance or proof of current on-site HTML.
