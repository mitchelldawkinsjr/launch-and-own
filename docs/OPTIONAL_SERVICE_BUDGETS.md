# Optional Workers, D1, KV and R2 budget review — #89

Reviewed November 22, 2026. This combines the numeric usage planner from #104 and the capability states, manual usage guidance and pause policy from #106. Sol coordinates #83. Domain owns hosted changes under #2.

## Static hosting and optional services

Launch & Own's existing GitHub-backed Cloudflare Pages *static site* remains usable without selecting or provisioning any Worker, D1 database, KV namespace or customer R2 bucket. Do not wrap static assets in a Worker merely to add optional features. Existing onboarding's **private ZIP-staging R2** serves a separate platform purpose; this feature never reuses it for customer data.

`pipeline/optional-service-budget.mjs` exports `PUBLISHED_FREE_LIMITS` and `prepareOptionalExtensionReview`. This pure asynchronous function has no provider API, resource-write, billing, OAuth, DNS or deployment dependency. It generates a **proposal fingerprint**, usage/permission warnings and capability states. It never stores consent or activates anything. A plan digest is *not* approval. No standalone billing calculator is provided and all monetary estimates remain `null`; all paid usage requires actual account-specific review.

## Published Cloudflare allowances (checked against official docs 2026-11-22)

| Product | Workers Free published limits | Critical caveat |
| --- | --- | --- |
| Workers and Pages Functions | 100,000 requests/day, **10 ms CPU per invocation** | CPU is a per-invocation cap, not a summed usage allowance. Workers Paid starts at **$5 USD/account/month**; paid requests/CPU carry their own overage prices and spending settings. |
| D1 | 5 million rows read/day, 100,000 rows written/day, 5 GB stored total, 10 databases | Each Free database has a separate 500 MB storage limit. Daily row limits can stop queries, and reads can scan more rows than returned. |
| KV | 100,000 reads/day, 1,000 writes/day, 1,000 deletes/day, 1,000 list requests/day, 1 GB storage, 1,000 namespaces | Operations through the Cloudflare dashboard/CLI count too. Free limits are enforced; they are **not** unlimited paid-free usage. |
| R2 Standard | 10 GB-month, 1 million Class A and 10 million Class B operations/month | Requires **separate customer R2 subscription checkout**, even for usage within the included Standard allowance. Beyond it usage is chargeable; Infrequent Access is **not** covered by that free inclusion. |

Official provider references
- Workers pricing and CPU: https://developers.cloudflare.com/workers/platform/pricing/
- Workers limits: https://developers.cloudflare.com/workers/platform/limits/
- D1 pricing: https://developers.cloudflare.com/d1/platform/pricing/
- D1 limits: https://developers.cloudflare.com/d1/platform/limits/
- D1 enforcement: https://developers.cloudflare.com/changelog/post/2026-09-01-d1-free-tier-limit-enforcement/
- KV pricing: https://developers.cloudflare.com/kv/platform/pricing/
- KV limits: https://developers.cloudflare.com/kv/platform/limits/
- R2 pricing: https://developers.cloudflare.com/r2/pricing/
- R2 mandatory subscription: https://developers.cloudflare.com/r2/get-started/
- Customer billing: https://developers.cloudflare.com/billing/understand/usage-based-billing/

These are **account-wide and plan-dependent allowances**, not remaining capacity. Other projects, functions and manual operations consume the same account budgets. Account-subscription billing cycles need provider evidence; never infer monthly remaining quota from an invented calendar window. API/GraphQL usage access and plan entitlements must be independently verified; a permissions grant to Pages is not permission to manage D1/KV/R2.

The owner QA ZIP upload used **95 ms CPU** for a 5.19 MiB archive. Workers Free allows **10 ms per invocation**, so an upload that fits the storage or body-size limits can still exceed Free CPU. [ZIP QA evidence](https://github.com/mitchelldawkinsjr/launch-and-own/issues/45#issuecomment-7087096052)

## Review contract and release safeguards

`prepareOptionalExtensionReview({ principal, site, accountEvidence, requests })` requires:
- The current backend-authenticated GitHub user ID and selected Cloudflare account, matching a server-held immutable project/repository reference plus current base SHA. The required `assertCurrentAuthorization` callback checks the live session and selected resources before and after async hashing.
- **Fresh** backend-verified owner-account plan and aggregate consumption (within 15 minutes), per-service permission evidence, and explicit R2 subscription state. The callback does not fetch provider facts itself, and the caller must verify those facts independently. A browser `kind:verified-account-plan-and-usage` string is **not evidence**.
- One to four distinct services, each specifying the proposed resource name, daily/monthly usage units, customer-owned dedicated resource scope, purpose, data classification, retention and deletion strategy. A compute plan distinguishes Workers from Pages Functions while using shared account allowances. Personal data requires bounded retention and time-bound deletion.
- Whole operation counts, explicit storage/CPU units and verified same-account evidence. A provider integration must independently validate the exact resource name and rule out account collisions.

The `state` uses the #84 capability vocabulary. The separate `status` identifies missing measurements or permissions, projected allowance overrun, separate R2 subscription checkout, paid billing review or a provisional estimate. The exact `reviewPlan` and its SHA-256 bind the displayed resource, verified site and account, base SHA, observed/forecast inputs and evidence expiry. `canActivate` and `canWrite` are always false and the cost estimate remains unavailable. A quota overrun pauses the proposed extension only. A forecast within published caps is provisional.

For example, customer-owned KV preferences with personal data require a deletion plan and explicit retention, while a public site with no dynamic API remains entirely static. To add a contact form, the owner must also separately approve recipient/delivery, anti-abuse/Turnstile verification (#88), **and** a distinct stored `#89` forms cost/privacy approval ([FORMS_COST_PRIVACY_APPROVAL.md](FORMS_COST_PRIVACY_APPROVAL.md)). A budget `planDigest` or KV/D1 forecast by itself is not a working form gate.

## Required next steps before activation

1. Domain/backend implements a **read-only account-wide usage/plan/permission observation** after current server-side owner/session/grant verification and rechecks the authorization epoch before and after each provider read. When measurements are missing, send the verified owner to the selected account dashboard to review usage, plan and R2 subscription. Do not treat manual statements as measured usage.
2. A future independent action must display the exact **account, website, dedicated resource, purpose, forecast, costs, storage/deletion policy, potential charges and the current plan**, with explicit separately recorded customer consent bound to current trusted evidence and the exact approval digest. Verify whether billing activation or new provider scopes are required; default all optional extensions OFF.
3. Require current provider state, existing resource collision checks, idempotency/retry guards and per-site naming/permissions before any future write. Never use platform ZIP staging for customer data or enable Workers Paid/R2 billing silently. All paid extensions require owner budget approval, including an expectation of charges when beyond allowances.
4. Provide enforceable per-customer request/size/rate/retention limits and a tested fail-closed flow for quota exhaustion. Under Free, D1/KV/Worker failures need truthful non-working states rather than silently dropping user submissions; paid account spending limits and alerting need owner review.
5. Independently verify tenant isolation, no raw secrets/PII in logs, user data export/deletion and rollback of application code and provider resources. Database/storage deletion is not guaranteed by reverting Git. Finish #21 separate consenting customer acceptance, Domain #2 release coordination and Sol #83 architecture review.

**Scope boundaries:** This proposal deliberately does not update `onboarding/worker.mjs`, OAuth scopes, Cloudflare resources, any customer file or active capability label. Advanced optional services remain `not_available` to customers until their own approved rollout. Review test command: `node --test pipeline/optional-service-budget.test.mjs`; full repository CI includes tests, distribution QA, onboarding preflight and Worker/D1 recovery where applicable.
