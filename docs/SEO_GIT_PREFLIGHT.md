# #88 — SEO Git tree and owner-approval preflight (code only)

**Implementing model:** GPT-6 (OpenAI). **Coordinator:** Sol 6.2 Max (#83). **Domain / hosted rollout owner:** #2.

This is an isolated read-only preflight following the merged SEO proposal generator in PRs #100/#101. The helper at site/seo-git-preflight.mjs does NOT create a GitHub PR, write a file, publish an SEO change, activate DNS/TLS or touch a Cloudflare account.

## Inputs and trust boundary

Call preflightApprovedSeoGitChange ONLY from a server that has separately authenticated the owner and fetched current evidence from the selected owner's GitHub/Cloudflare integrations, not from a browser or an AI agent:

- site and sourceKind: the previously saved customer-authored generated site configuration; only generated-one-page and generated-multi-page. Imported ZIP/custom sites stay manual review.
- trustedSite: immutable current GitHub user/repo IDs, Cloudflare account/Pages project IDs, main, and exact expected base Git SHA, matching the active owner session.
- domainEvidence: independently verified DNS/TLS/custom-domain-to-Pages evidence matching the same owner/project/source; the existing #101 proposal refuses expired/invalid/self-asserted evidence.
- reviewProposal: exact previously shown private SEO proposal including complete HTML, canonical/OG, robots and sitemap bytes.
- approvedProposalSha256: SEPARATELY STORED owner approval of that exact proposal. It must NOT be populated from an untrusted POST field or inferred from reviewProposal itself.
- mainBranch, pinnedCommit, pinnedTree: fresh backend GitHub GETs on the owner repository and expected SHA; full nontruncated recursive tree, exact commit/tree SHA.
- pinnedFiles: exact bytes and Git blob SHA of every generated HTML page fetched at that immutable commit; never a mutable branch-relative or browser value.
- assertCurrentAuthorization(): required server callback that RETURNS true only for the still-current owner, selected account, session/epoch and grants. It runs before and after async verification; false, throw or reject block the preflight.

The preflight regenerates the proposal, compares the manifest digest to separately approved digest and all complete proposed bytes to the reviewed proposal, computes SHA-256 of current HTML and actual Git blob SHA-1 (including Git blob header), checks tree paths/modes/parents, and rejects stale main commits, symlinks, case-fold collisions, overwritten robots/sitemaps, unreviewed public HTML routes and changed originals. Each generated page is limited to 128 KiB and recursive tree to 4,096 entries.

The result contains a PRIVATE review candidate manifest with ownerApprovalMatched=true, readyForProviderWrite=false, publicationVerified=false, requiresSeparatePrExecution=true and requiresManualMerge=true. DO NOT log or expose private HTML in the result. Unlike #39 managed-sidecar preflight, this only validates generated SEO files, not site source migration, sidecars or ZIPs.

## Remaining release gates

1. Domain #2 / inventory #39 must provide authenticated immutable source + independently verified domain evidence for that customer's Pages project.
2. Separately store explicit private owner approval bound to the complete proposed files, proposal digest and expected base SHA plus current authorization epoch.
3. #30's independent owner-approved same-repository PR executor must recheck account/grants/branch/bytes immediately before writing, preserve sidecar safety and never auto-merge.
4. Customer manually merges; separately verify canonical production Git SHA and actual publicly served HTML bytes. A preview, PR creation or preflight is NOT publication.
5. #21 independent external customer acceptance and Domain #2 approval remain required; no live customer verification is claimed in this PR.

Run node --test site/seo-git-preflight.test.mjs, npm test, distribution/preflight and Worker/D1 recovery QA.

Only three new files are in this PR: module, regression tests and this document. No Worker, D1 migration, pricing, OAuth, DNS, MX, provider settings or real customer resource is changed.
