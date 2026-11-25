# #86 — Review-only previous-homepage restore plan

**Implementing model:** GPT-6 (OpenAI). **Coordination:** Sol 6.2 Max (#83). **Customer/hosted gates:** Domain #2, safe-update executor #30, independent beta #21.

## Scope

The pure `buildReviewedHomepageRevert` helper in `pipeline/reviewed-homepage-revert.mjs` proposes **a GitHub PR to restore the previous HTML file** on a **verified, legacy one-page generated** customer site. It NEVER calls GitHub or Cloudflare, updates the Pages deployment, merges a branch, changes DNS, alters a stored approval, or publishes a page. It is not a one-click rollback button.

Cloudflare Pages Git-connected production is sourced from the repository's `main`; a Pages-only rollback can serve content that diverges from Git `main`. A normal owner-controlled recovery should instead be a separately approved reviewable Git PR, manual merge and independent canonical production SHA + public HTML digest verification. Even after a merge, Pages may queue or fail a deployment; the plan therefore always reports `publicationVerified:false` and `previousDeploymentRestored:false`. This path does not enable public preview builds or bypass the separate Access checks (#86).

## Trust contract — backend-only evidence

The future server caller must derive each item from currently authenticated owner/grant, verified managed-site inventory, **fresh immutable GitHub GETs**, and current provenance. Never take user-supplied repository IDs, Git trees, blob bytes or callbacks as authoritative.

- `trustedSite`: immutable GitHub user ID, repository ID, Cloudflare account ID, Pages project ID/name, production branch `main`, and the exact expected `main` commit SHA. The caller must separately verify the matching Git-connected Pages project before invoking this pure helper.
- `sourceKind='generated-one-page'` must come from server-backed verified source/provenance. Raw ZIP, imported, multipage and custom sites are unsupported. `assertGeneratedOnePageEligibility(context)` must return **true** from an independent server-backed check for the current site and both commit revisions, not blindly trust the sourceKind label.
- `currentBranch`, `currentCommit`, `parentCommit`, `currentTree`, `parentTree`: branch `main` must equal approved expected SHA. The latest commit must have **one direct parent only**; this is not a generic merge-revert engine. Both recursive Git trees must be complete, nontruncated and valid, with up to 4,096 entries. Source files may differ **only** at `public/index.html` (the `public` directory tree SHA naturally advances as a result). New/deleted/changed assets, other HTML routes, symlinks/submodule homepage, sidecars and path collisions all block the plan.
- `currentHomepage`, `parentHomepage`: exact file bytes fetched at **immutable SHA references** with Git blob SHA, each bounded to 128 KiB. Both SHA-1 of the actual Git `blob <bytes>\0<content>` format and SHA-256 of HTML bytes are recalculated and matched to the supplied complete trees.
- `assertCurrentAuthorization(context)` must return **true** for the active user, selected GitHub/Cloudflare account and repo, current session/authorization epoch and unrevoked grants. Both auth/provenance callbacks run before and after asynchronous hashing. Errors, `false`, and in-flight mutation of any trusted evidence fail closed.

The returned `approvalReviewDigest` binds immutable owner/repo/account/project IDs, both commit/tree SHAs, both source Git blob hashes, both HTML digests and exact target path. This is **the digest the owner must later review and approve**, not evidence that they have already approved anything. The return includes the complete private previous HTML for an eventual authenticated owner review; do not log or expose it to another tenant.

A separate durable owner approval record must bind that digest, exact base revision, owner and current consent/session epoch. This function always returns `requiresSeparateOwnerApproval:true`, `readyForProviderWrite:false`, `requiresSameRepositoryPr:true`, `requiresManualMerge:true` and `requiresIndependentPostMergeVerification:true`.

## Remaining work and limits

1. Domain #2 / inventory #39 exposes a safe, authenticated backend read for both immutable commits and verifies the exact Pages Git project. This helper cannot authenticate arbitrary JavaScript objects by itself.
2. The customer privately reviews the full previous HTML and confirms a separate rollback proposal digest, with source metadata and intended effect. Any changes since review invalidate consent.
3. A later #30-approved writer **re-reads** current `main`, provider grants and pinned files immediately before proposing a same-repo GitHub feature branch + PR; no direct `main` write or auto-merge.
4. The owner manually merges, and the hosted app separately observes the exact production Git commit and publicly served HTML bytes; only then can it report restored content.
5. Test multiple updates, merge commits, other changed files, ZIP/multipage sites, expiry and independent owner acceptance under #21 before exposing a recovery control.

**QA:** `node --test pipeline/reviewed-homepage-revert.test.mjs`, `npm test`, `npm run qa:distribution`, `npm run preflight:onboarding`. This PR contains only three new files; no Worker, D1, customer GitHub write, OAuth scopes, Pages preview, DNS or billing mutation. **No real-customer release claim.**

See also [safe customer website updates](SAFE_WEBSITE_UPDATES.md), [protected preview acceptance](TOOLKIT_PREVIEW_ACCEPTANCE.md), [managed sidecar contract](MANAGED_SITE_CONFIG.md).
