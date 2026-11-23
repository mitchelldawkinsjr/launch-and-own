# Cloudflare Pages PR preview safety gate (#86)

**Implementation: GPT-6 (OpenAI), 2026-11-22. Status: code-only read-only verifier, not hosted/activated.** Sol 6.2 Max orchestrates #83, and Domain controls production changes via #2.

## Confirmed baseline and threat model

Existing approved GitHub-connected Pages projects set `source.config.preview_deployment_setting='none'`. Cloudflare Pages preview deployments are **public by default**. Simply switching to `all` could disclose a draft *before* our application has a chance to hide or verify the URL. The verifier is NOT access control; private review continues through the separate exact authenticated HTML/ZIP preview. Do not allow unapproved ZIP contents or private customer copy onto a publicly building preview branch.

Official current docs:
- https://developers.cloudflare.com/pages/configuration/preview-deployments/
- https://developers.cloudflare.com/pages/configuration/branch-build-controls/
- https://developers.cloudflare.com/api/resources/pages/subresources/projects/methods/get/
- https://developers.cloudflare.com/api/resources/pages/subresources/projects/subresources/deployments/methods/get/

The accepted Cloudflare `custom` branch policy is aligned with Domain PR #90: include exactly `launch-and-own/site-*`, **exclude exactly `main`**, with no extra branch patterns or automatic PR comments. **This alone does not protect privacy:** every matching branch can become publicly viewable, including before a specific PR consent. Prevent creation of eligible branches until owner privacy choice and project policy are verified. Enforce Cloudflare Access for confidentiality-sensitive cases *before* enabling previews, or keep them completely off.

## Implemented read-only contract

`pipeline/pages-pr-preview.mjs` exports `verifyExistingPrPreview({site, consent, prNumber, deploymentId}, {githubToken, cloudflareToken, fetchFn})`. Callers MUST supply `site` and `consent` from independently verified, owner-scoped backend records. Never use arbitrary browser, model, querystring or stale 30-day receipt fields. There is **no code to store approval, enable preview builds, create a branch, merge or deploy** in this PR.

### Review outcome — metadata only (Sol 6.2 Max / #96)

The current implementation **never returns a preview URL**, never requests preview HTML, and never claims that Cloudflare Access protection or signed-in content verification occurred. The only positive result is `preview-metadata-verified-protection-pending`, with `previewUrl: null`, `protectionVerified: false`, `contentVerified: false`, and `productionVerified: false`. It is NOT a publish, protected-link, or launch approval. Client-provided `accessVerified` flags and approvals cannot upgrade this state.

The read-only metadata checkpoint checks:

1. A trusted, unexpired, separate consent bound to immutable GitHub user and repository, Cloudflare account and Pages project, PR number, **approved base SHA and staged head SHA**, plus approved homepage digest. The digest is retained for later protected content review, but is **not compared against any public preview in this PR**.
2. Live GitHub authenticated owner and private managed repo. The current Cloudflare project is verified using the **shared `matchesApprovedPagesProject` matcher (#95)**, plus strict decimal-safe primitive repository IDs and `source.config.owner_id` when reported. The eventual #95 merge will strengthen the shared implementation itself.
3. An exact `custom` branch policy: only `launch-and-own/site-*` included; exactly `main` excluded; **`pr_comments_enabled: false` explicitly observed**. These settings are exposure evidence only, not protection. Native GitHub checks and retained deployment aliases may still expose preview URLs independently of this application.
4. Same-repo, open PR with exact approved `base.sha` and `head.sha`, unchanged live `main` and staged branch tips, and a successful same-project GitHub-triggered preview deployment at that exact head. A provider URL's immutable hostname must match the reported deployment short ID, but its URL is **neither returned nor fetched**.

All provider requests are authenticated GETs. The verifier makes **no request to `pages.dev`, `/index.html` or `/`**, because an anonymous content GET is not a valid Cloudflare Access-protected browser acceptance check. Missing/revoked grants, moved heads, wrong owners, unexpected settings or deployments fail closed.

**The current OAuth grants cannot independently inspect Cloudflare Access applications/policies.** No preview content can be described as protected or reviewed until a separate, owner-authorized pilot establishes Access policy and exact immutable/alias host coverage before any eligible push, checks unauthenticated denial and signed-in allowed content on the canonical `/`, verifies full approved output, and tests retained deployments. The domain policy PATCH executor (#90) stays out of any release path. **Disabling new preview builds does not delete previews already published.** See #96 for the independent acceptance plan.

## Future integration and release gates

1. Sol #84 verifies actual scopes, quotas, Cloudflare Pages and Access behavior; #39 supplies durable owner inventory past the 30-day launch history TTL; #30 retains exact approved edit PR flow. Coordinate contested `onboarding/worker.mjs` changes through Domain #2 and #41.
2. A separately reviewed UI flow must show specific repo/account/site, preview exposure, build usage and plan limits; record an independent, CSRF-protected consent with expiry and withdrawal. No automatic approval derived from ordinary website-PR approval.
3. Privately inspect the project's existing access restrictions *before* enabling any branch previews. Confirm owner approval for exact provider changes; do not mutate settings in #86's read-only slice. New and already-launched sites follow the same check.
4. Only after approvals, set and verify an exact project-level opt-in rule. Never change every customer project or use `all`. Test with a separately consenting account. If privacy cannot be preserved for a customer's requirements, remain disabled.
5. Recheck PR/project/SHA and separately verified Access + authenticated canonical content before any preview link is displayed; let the owner manually merge, then use the existing **canonical production SHA + public HTML digest** verifier. Preview existence is not publication proof.

**Rollback:** Restore `preview_deployment_setting='none'` using a separately reviewed and authorized provider write to stop new builds. Existing preview URLs may remain public until deleted or expired; disabling new builds does *not* retroactively protect them. For published website rollback, prefer a reviewed Git revert PR, manual merge and canonical source/HTML verification rather than a Pages-only rollback that disagrees with `main`.

## Validation and status

- Focused tests: `node --test pipeline/pages-pr-preview.test.mjs` (GET-only, owner_id/repository identity, approved immutable base/head, branch-policy and native comment gates, deployment linkage, malicious provider URLs, no public GET, and spoofed Access flags). Signed-in Access and canonical full-artifact digest checks remain future independent acceptance gates.
- Repository gates: `npm test`, `npm run qa:distribution`, `npm run preflight:onboarding` and recovery QA where relevant, followed by GitHub Actions CI.
- **Not completed:** customer UI wiring; hosted/stored consent; any approved preview enablement; signed-in Access protection and canonical content verification; protected pilot; screenshots; independent acceptance #21; #39 inventory; Domain #2 rollout approval. No production account, DNS, OAuth, billing or customer data was touched.

Model attribution: **GPT-6** authored this implementation scope and its GitHub updates; Sol 6.2 Max is the cross-agent orchestration lead.
