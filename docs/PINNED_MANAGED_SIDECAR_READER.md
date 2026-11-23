# Read-only SHA-pinned managed-site sidecar evidence (#39)

**Implementation model: GPT-6 (OpenAI). Code-only, not hosted, not merged, not deployed.**

The approved-on-review #39 structured editor planner in [PR #103](https://github.com/mitchelldawkinsjr/launch-and-own/pull/103) deliberately refuses unverified sidecar proof. The existing merged [#98](https://github.com/mitchelldawkinsjr/launch-and-own/pull/98) can verify a current managed GitHub repository/Pages linkage and read the current `public/index.html` at a SHA-pinned `main` commit; it does **not** read the private structured config. This separate GET-only adapter supplies the missing backend proof without enabling the editor.

## Backend-only integration contract

`pipeline/pinned-managed-sidecar.mjs` exports `readPinnedManagedSidecar({siteId,reference,principal,githubAccessToken,cloudflareAccessToken,assertCurrentAuthorization,fetchFn?})`.

- `principal` must be an authenticated, still-selected owner identity (`githubUserId`, `githubLogin`, `cloudflareAccountId`). `reference` must come from a **server-held, session-and-epoch-bound, authenticated** selection of a previously verified site, such as the encrypted reference ticket in the separately reviewed #109 workstream. Never accept an untrusted browser/object/AI-provided reference or treat a guessed `siteId` as authority.
- `assertCurrentAuthorization(frozenOwnerIdentity)` must independently recheck the current backend session, authorization epoch, selected Cloudflare account and live provider grants from current D1 state on every call. This adapter is isolated from the Worker/session schema. The supplied callback is a required trusted caller dependency; returning `true` as a constant is **not production authorization**.
- First call #98's `readCurrentManagedHomepage` with the current principal/ref/tokens. That function verifies the GitHub user, exact private managed repository ID/owner, exact linked Cloudflare Pages project ID/source/static output and the latest `main` SHA, reads the exact current homepage, hashes its actual bytes and repeats the owner/source/branch checks.
- Next read `GET /repos/{owner}/{repo}/contents/.launch-and-own/site-config.json?ref={pinnedSha}` with the GitHub token. A confirmed 404 at that exact repo SHA returns `sidecarEvidence:{path,siteId,refCommitSha,exists:false}` and `sidecarRaw:null`; **not** proof of source kind or permission grant. 401, ordinary 403, throttled 403, 429, redirects, malformed JSON and transport failures fail closed rather than being reported as absence.
- A valid GitHub file response must be a <= 16 KiB UTF-8, base64-encoded blob with a full GitHub blob SHA. The reader computes SHA-256 over the **actual decoded bytes** (preserving a BOM in the internal UTF-8 representation). It returns `sidecarEvidence:{path,siteId,refCommitSha,exists:true,blobSha,contentSha256}` and `sidecarRaw` internally.
- After a sidecar read, re-read the current `main` branch, immutable GitHub repository/owner and Cloudflare Pages project/source to fail closed on same-name resource replacement or branch movement while the proof was being fetched. Re-check authorization before and after every provider read and once at the end.

The result contains `{status:'pinned_sidecar_evidence_verified',currentSource,sidecarEvidence,sidecarRaw,historicalContinuityVerified:false,editorEligible:false,providerWriteAuthorized:false}`. Raw homepage HTML and sidecar text are **PRIVATE untrusted customer content**. Never return them from `/toolkit/source`, render them within the trusted onboarding origin, put them in telemetry, logs or public GitHub comments, or persist them past the current consent-bound review.

The adapter is bounded to **12 provider GETs per invocation** (eight for #98's current-source proof, one sidecar read and three final revalidation reads), plus mandatory D1 session fences on each GET. With one D1 query per fence, budget approximately 38 subrequests, below the Workers Free allowance of 50, excluding any additional caller work. Domain must check the **entire route's** token refresh and other provider calls before integrating it. Neither this helper nor a 404 is a promise of complete owner-site inventory.

## What this does not authorize

- Does not assert a site was *generated* by Launch & Own or that it uses the supported one-page renderer. Current ownership and a copied editable repo marker are not historical continuity. [PR #103](https://github.com/mitchelldawkinsjr/launch-and-own/pull/103) separately requires pinned historical launch eligibility or separately owner-approved adoption and a live backend `assertGeneratedOnePageEligibility` callback.
- Does not propose or create a GitHub branch or PR, rewrite `public/index.html`, create a missing sidecar, change Pages settings, enable Analytics or protected previews, deploy, change D1 schema or store customer content.
- Does not remove the need for an **explicit human review** of exact current bytes and a separate protected consent-bound branch/PR executor, followed by independent merge and exact public byte verification.
- Does not make arbitrary ZIP, multi-page or hand-edited HTML automatically editable in the structured one-page form.

## Remaining dependencies and QA

- #2 / Domain and #109 own live session/epoch-bound site-reference handoff, refresh token plumbing, authentication, no-store routes and browser privacy. This code deliberately adds **no Worker/UI files** or shared route.
- #83 / Sol reviews this code-only sidecar proof contract relative to #98 and #103 before integration.
- #30 and #39 own the later exact approved source migration/PR editor; #21 independent owner/customer acceptance and hosted go-live authorization remain open.
- Tests cover valid sidecar, same-commit 404, BOM-byte digest, malformed file/base64/UTF-8, wrong site/account or immutable resource IDs, moving `main`, session revocation and account mutation during sidecar I/O, token-safe errors, strict GET-only transport, and request count. Run `npm test`, distribution QA, preflight, Worker syntax, and local Worker/D1 recovery.

**Rollback:** revert the three new helper/test/doc files; no stored/customer/provider state exists to undo. **Implementing model: GPT-6.**
