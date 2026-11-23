# Static SEO review proposal — Issue #88

**Implementation model: GPT-6 (OpenAI).** Code-only proposal, **not a hosted capability**. Sol 6.2 Max coordinates #83; Domain owns DNS, Cloudflare zones, mail and forms. No customer edits or provider writes are performed by this module.

## Included in this isolated slice

The exported buildSeoReviewProposal function generates an immutable, deterministic, **owner-reviewable artifact plan** for the two generated site layouts already supported by Launch & Own.

- Single-page: public/index.html with verified-origin canonical, Open Graph title/description/type/URL, and Twitter summary card metadata.
- Four-page: per-page canonical and Open Graph URLs for /, /about/, /services/ and /contact/ (verified origin required).
- public/robots.txt and public/sitemap.xml with the corresponding routes. The helper refuses any existing robots/sitemap file collision.
- An exact plan with each expected rendered-source SHA-256, proposed-page SHA-256 and proposed file byte. The manifest SHA-256 binds the plan to the expected base Git SHA, site identities and canonical origin. A future verifier compares the expected rendered-source digests with the actual pinned bytes.

Results explicitly carry status=review-required, publicationVerified=false and requiresOwnerApproval=true. No API request, GitHub PR, Cloudflare setting, DNS, domain/TLS, billing or deployment changes are performed. This PR never alters the default renderers or existing approved files.

## Trusted canonical and exact content remain separate gates

A canonical URL asserts a preferred public website address. **Do not infer it from a Pages preview, AI response, customer-entered hostname or user-controlled boolean.** The trustedSite and domainEvidence inputs must both be supplied by the current server-controlled, independently authenticated owner/provider verification path. They bind the immutable GitHub user/repo IDs, selected Cloudflare account, Pages project ID/name and current Git source SHA. Evidence expires within 24 hours. The helper checks these fields and HTTPS origin syntax, but **cannot independently prove DNS ownership or TLS**. No hosted caller should exist until a real domain verifier is reviewed.

A separately reviewed future adapter must:

1. Revalidate the owner session, account selection and grants before and after every provider read.
2. Reverify the exact domain's DNS/TLS and selected Pages project, current GitHub main SHA and immutable identities. Ensure the domain is exclusively approved for this site.
3. Read the exact source at the expected Git SHA, compare every beforeSha256 with actual source and reject changed/extra/unmanaged files. Never presume a deterministic renderer equals a manually modified current website.
4. Show ALL proposed HTML, sitemap and robots content privately; record explicit separate approval tied to proposalSha256 and expected base SHA. Any domain, page, content, ordering or SEO-control change requires reapproval.
5. Create a same-repository reviewable Git PR, require manual owner merge, then independently verify the canonical production SHA and actual served bytes. A successful preview/build alone is not proof of publication.

## ZIP preservation and truthful business schema

Only generated-one-page and generated-multi-page sources are eligible for this code-only plan. Imported ZIP or custom sites return manual-review-required and **zero file changes**. Customer ZIPs may contain their own canonical, sitemap, robots, markup, custom styles, assets and security configuration. Never silently rewrite them.

The current proposal only reuses existing validated page titles/descriptions and verified-origin metadata. It does **not** invent addresses, hours, certifications, customer reviews, ratings, logos, images or third-party scripts. LocalBusiness/Organization JSON-LD and social images remain separate verified customer-fact/asset proposals with their own exact approval. The original CSP remains intact.

Custom domain registration, redirects, Email Routing, Turnstile forms, customer DNS/MX/SPF/DKIM, WAF/security upgrades and billing are not part of this PR. Owner consent, accurate plan/permissions claims and independent customer acceptance are required for those future #88 workstreams.

## API contract and release status

Call buildSeoReviewProposal with sourceKind, site, trustedSite, domainEvidence and the explicit existingPaths from the pinned Git tree. The inventory must include every generated page. It returns files containing path, action, beforeSha256, afterSha256 and complete proposed bytes, plus proposalSha256. Missing or inconsistent evidence returns an empty plan with a blocked status.

Tests: node --test site/seo-review-proposal.test.mjs; npm test; npm run qa:distribution; npm run preflight:onboarding.

**Release gate:** No hosted route or provider adapter; #39 current inventory, #30 reviewed update PR, #21 independent customer acceptance and Domain #2 approval remain open. All production resources remain unchanged by GPT-6.
