# Cloudflare Pages PR preview safety gate (#86)

**Implementation: GPT-6 (OpenAI), 2026-11-22. Status: code-only read-only verifier, not hosted/activated.** Sol 6.2 Max orchestrates #83, and Domain controls production changes via #2.

## Confirmed baseline and threat model

Existing approved GitHub-connected Pages projects set `source.config.preview_deployment_setting='none'`. Cloudflare Pages preview deployments are **public by default**. Simply switching to `all` could disclose a draft *before* our application has a chance to hide or verify the URL. The verifier is NOT access control; private review continues through the separate exact authenticated HTML/ZIP preview. Do not allow unapproved ZIP contents or private customer copy onto a publicly building preview branch.

Official current docs:
- https://developers.cloudflare.com/pages/configuration/preview-deployments/
- https://developers.cloudflare.com/pages/configuration/branch-build-controls/
- https://developers.cloudflare.com/api/resources/pages/subresources/projects/methods/get/
- https://developers.cloudflare.com/api/resources/pages/subresources/projects/subresources/deployments/methods/get/

The supported Cloudflare `custom` branch rule may include ONLY `launch-and-own/site-*`, with no exclusions or automatic PR comments. **This alone does not protect privacy:** every matching branch can become publicly viewable, including before a specific PR consent. Prevent creation of eligible branches until owner privacy choice and project policy are verified. Enforce Cloudflare Access for confidentiality-sensitive cases *before* enabling previews, or keep them completely off.

## Implemented read-only contract

`pipeline/pages-pr-preview.mjs` exports `verifyExistingPrPreview({site, consent, prNumber, deploymentId}, {githubToken, cloudflareToken, fetchFn})`. Callers MUST supply `site` and `consent` from independently verified, owner-scoped backend records. Never use arbitrary browser, model, querystring or stale 30-day receipt fields. There is **no code to store approval, enable preview builds, create a branch, merge or deploy** in this PR.

The function refuses to surface a preview URL without:

1. An unexpired, explicit and **separate public-exposure acknowledgement**, bound to immutable GitHub owner ID, repository ID, Cloudflare account ID, Pages project ID, PR number, head SHA and approved homepage SHA-256. A site that requires private previews is rejected.
2. Live GitHub rechecks for authenticated user, private managed repository, exact IDs, default branch and managed source marker; live Cloudflare recheck for the correct GitHub source/project/build settings and the narrow `custom` preview policy. Disabled previews return `preview-disabled` rather than a fabricated URL.
3. An **open same-repo PR** targeting `main`, in an existing `launch-and-own/site-<20 hex>` branch with an unchanged, separately approved exact PR head SHA.
4. A successful non-skipped Cloudflare `preview` deployment for the same immutable Pages project ID, branch, exact commit hash and GitHub push trigger. The deployment must finish its `deploy` stage.
5. A provider-returned immutable preview URL whose single hostname label equals `deployment.short_id` (8 hexadecimal characters), matching the project `pages.dev` suffix. Never trust a moving branch alias, custom URL, user-supplied host, HTTP URL, redirect, querystring or a nested subdomain. Read `/index.html` with a 2 MiB streaming bound, no redirects, and check the original approved HTML SHA-256 **before** showing the URL.

All provider calls are GETs, with tokens confined to provider requests. Even success returns `environment:'preview'` and `productionVerified:false`. Missing/revoked authorization and provider failures cannot be converted to a fake live or preview status.

**Important:** The read-only check cannot prevent content already public on Pages from being seen independently. An application hiding a URL is never a privacy guarantee. Independently test Cloudflare Access protection with an unauthenticated browser before treating any protected preview as confidential.

## Future integration and release gates

1. Sol #84 verifies actual scopes, quotas, Cloudflare Pages and Access behavior; #39 supplies durable owner inventory past the 30-day launch history TTL; #30 retains exact approved edit PR flow. Coordinate contested `onboarding/worker.mjs` changes through Domain #2 and #41.
2. A separately reviewed UI flow must show specific repo/account/site, preview exposure, build usage and plan limits; record an independent, CSRF-protected consent with expiry and withdrawal. No automatic approval derived from ordinary website-PR approval.
3. Privately inspect the project's existing access restrictions *before* enabling any branch previews. Confirm owner approval for exact provider changes; do not mutate settings in #86's read-only slice. New and already-launched sites follow the same check.
4. Only after approvals, set and verify an exact project-level opt-in rule. Never change every customer project or use `all`. Test with a separately consenting account. If privacy cannot be preserved for a customer's requirements, remain disabled.
5. Recheck PR/project/SHA, display only a verified preview; let the owner manually merge, then use the existing **canonical production SHA + public HTML digest** verifier. Preview existence is not publication proof.

**Rollback:** Restore `preview_deployment_setting='none'` using a separately reviewed and authorized provider write to stop new builds. Existing preview URLs may remain public until deleted or expired; disabling new builds does *not* retroactively protect them. For published website rollback, prefer a reviewed Git revert PR, manual merge and canonical source/HTML verification rather than a Pages-only rollback that disagrees with `main`.

## Validation and status

- Focused tests: `node --test pipeline/pages-pr-preview.test.mjs` (GET-only, approval/identity/tenant, branch and SHA, unsafe config, immutable URL/SSRF, failed deployments, exact HTML digest, redirects and size limits).
- Repository gates: `npm test`, `npm run qa:distribution`, `npm run preflight:onboarding` and recovery QA where relevant, followed by GitHub Actions CI.
- **Not completed:** wired standalone customer UI, enabled or verified provider preview policies, live Access enforcement, owner browser consent, screenshots, independent customer acceptance #21, #39 owner inventory, Domain #2 hosted release approval. No production account, DNS, OAuth, billing or customer data was touched.

Model attribution: **GPT-6** authored this implementation scope and its GitHub updates; Sol 6.2 Max is the cross-agent orchestration lead.
