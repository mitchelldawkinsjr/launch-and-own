# Optional Workers, D1, KV and R2 budget review — #89

**Implementation model: GPT-6 (OpenAI), reviewed November 22, 2026. Status: read-only code-only review foundation, not customer-live.** Sol 6.2 Max orchestrates #83 and Domain owns #2 hosted changes.

## Default stays static and $0 where actually supported

Launch & Own's existing GitHub-backed Cloudflare Pages *static site* remains usable without selecting or provisioning any Worker, D1 database, KV namespace or customer R2 bucket. Do not wrap static assets in a Worker merely to add optional features. Existing onboarding's **private ZIP-staging R2** serves a separate platform purpose; this feature never reuses it for customer data.

`pipeline/optional-service-budget.mjs` exports `PUBLISHED_FREE_LIMITS` and `prepareOptionalExtensionReview`. This pure asynchronous function has no provider API, resource-write, billing, OAuth, DNS or deployment dependency. It generates a **proposal fingerprint**, usage/permission warnings and capability states. It never stores consent or activates anything. A plan digest is *not* approval. No standalone billing calculator is provided and all monetary estimates remain `null`; all paid usage requires actual account-specific review.

## Published Cloudflare allowances (checked against official docs 2026-11-22)

| Product | Workers Free published limits | Critical caveat |
| --- | --- | --- |
| Workers and Pages Functions | 100,000 requests/day, **10 ms CPU per invocation** | CPU is a per-invocation cap, not a summed usage allowance. Workers Paid starts at **$5 USD/account/month**; paid requests/CPU carry their own overage prices and spending settings. |
| D1 | 5 million rows read/day, 100,000 rows written/day, 5 GB stored total, 10 databases | Reads can scan more rows than returned. Free query daily limits **fail when exhausted** (enforced since September 1, 2026). |
| KV | 100,000 reads/day, 1,000 writes/day, 1,000 deletes/day, 1,000 list requests/day, 1 GB storage, 1,000 namespaces | Operations through the Cloudflare dashboard/CLI count too. Free limits are enforced; they are **not** unlimited paid-free usage. |
| R2 Standard | 10 GB-month, 1 million Class A and 10 million Class B operations/month | Requires **separate customer R2 subscription checkout**, even for usage within the included Standard allowance. Beyond it usage is chargeable; Infrequent Access is **not** covered by that free inclusion. |

Official current references:
- Workers pricing and CPU: https://developers.cloudflare.com/workers/platform/pricing/
- Workers limits: https://developers.cloudflare.com/workers/platform/limits/
- D1 pricing: https://developers.cloudflare.com/d1/platform/pricing/
- D1 enforcement: https://developers.cloudflare.com/changelog/post/2026-09-01-d1-free-tier-limit-enforcement/
- KV pricing: https://developers.cloudflare.com/kv/platform/pricing/
- R2 pricing: https://developers.cloudflare.com/r2/pricing/
- R2 mandatory subscription: https://developers.cloudflare.com/r2/get-started/
- Customer billing: https://developers.cloudflare.com/billing/understand/usage-based-billing/

These are **account-wide and plan-dependent allowances**, not remaining capacity. Other projects, functions and manual operations consume the same account budgets. Account-subscription billing cycles need provider evidence; never infer monthly remaining quota from an invented calendar window. API/GraphQL usage access and plan entitlements must be independently verified; a permissions grant to Pages is not permission to manage D1/KV/R2.

## Review contract and release safeguards

`prepareOptionalExtensionReview({ principal, site, accountEvidence, requests })` requires:
- The current backend-authenticated GitHub user ID and selected Cloudflare account, matching a server-held immutable project/repository reference plus current base SHA.
- **Fresh** backend-verified owner-account plan and aggregate consumption (within 15 minutes), per-service permission evidence, and explicit R2 subscription state. The planner does not fetch provider facts itself, and the caller must verify those facts independently. A browser `kind:verified-account-plan-and-usage` string is **not evidence**. The caller must also supply a trusted server-side `assertCurrentAuthorization(identitySnapshot)` callback that checks the **live session epoch, current selected account/site and active grants before and after asynchronous hashing**; missing, revoked, thrown or changed authorization yields no digest. A constant `() => true` callback is valid only in isolated unit-test fixtures, **not production**. The identity snapshot contains account/repository/project IDs and commit SHA but never tokens, customer usage data or personal submissions.
- One to four distinct services, each specifying exact daily/monthly usage units, customer-owned **dedicated** resource scope, its purpose, data classification, retention period and deletion strategy. Personal data requires an explicit bounded retention period and time-bound deletion plan.
- No extra forecast metrics, unsigned special resource names, unsupported storage class, negative usage, foreign owner/account, expired provider evidence, or mutated review input between the original calculation and digest completion.

Supported statuses distinguish estimate-inside-Free, missing account-wide usage, missing permissions, projection exceeding Free, separate R2 subscription checkout, paid plan cost review, and R2 usage-based billing review. **None is an activation approval.** The result always has `canActivate:false`, `canWrite:false`, `costEstimateUsd:null`, and no token or resource URL. Its internal forecasting states are **not** the six customer-facing #84 capability states: Composer PR #106 owns the eligibility/owner-facing catalog, and Sol must explicitly reconcile a single user-facing contract before integration. Forecast-inside-Free means only that a provided estimate and usage snapshot fit the *published* caps. It is never a promise of remaining allowance, no-charge usage or a zero-cost deployment.

For example, customer-owned KV preferences with personal data require a deletion plan and explicit retention, while a public site with no dynamic API remains entirely static. To add a contact form, the owner must also separately approve recipient/delivery, anti-abuse/Turnstile verification, retention and privacy disclosures (#88); an extra KV/D1 resource by itself is not a working form.

## Required next steps before activation

1. Domain/backend implements a **read-only account-wide usage/plan/permission observation** after current server-side owner/session/grant verification; recheck authorization epoch before and after every provider read. If usage cannot be observed with granted scopes, return `usage_unverified` and show the official provider dashboard fallback, without inventing a measured zero.
2. A future independent action must display the exact **account, website, dedicated resource, purpose, forecast, costs, storage/deletion policy, potential charges and the current plan**, with explicit separately recorded customer consent bound to current trusted evidence and the exact approval digest. Verify whether billing activation or new provider scopes are required; default all optional extensions OFF.
3. Require current provider state, existing resource collision checks, idempotency/retry guards and per-site naming/permissions before any future write. Never use platform ZIP staging for customer data or enable Workers Paid/R2 billing silently. All paid extensions require owner budget approval, including an expectation of charges when beyond allowances.
4. Provide enforceable per-customer request/size/rate/retention limits and a tested fail-closed flow for quota exhaustion. Under Free, D1/KV/Worker failures need truthful non-working states rather than silently dropping user submissions; paid account spending limits and alerting need owner review.
5. Independently verify tenant isolation, no raw secrets/PII in logs, user data export/deletion and rollback of application code and provider resources. Database/storage deletion is not guaranteed by reverting Git. Finish #21 separate consenting customer acceptance, Domain #2 release coordination and Sol #83 architecture review.

**Scope boundaries:** This proposal deliberately does not update `onboarding/worker.mjs`, OAuth scopes, Cloudflare resources, any customer file or active capability label. Advanced optional services remain `not_available` to customers until their own approved rollout. Review test command: `node --test pipeline/optional-service-budget.test.mjs`; full repository CI includes tests, distribution QA, onboarding preflight and Worker/D1 recovery where applicable.
