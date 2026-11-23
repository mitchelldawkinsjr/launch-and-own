# Post-launch stored option requests — #88

The existing `/site-options` toolkit page lets a verified owner review and store separate hostname, forwarding-email, forms, visitor-insights (Web Analytics), scoped PR-preview, SEO starter, and same-host redirect requests. Each request recomputes its digest server-side; email fingerprints include the **exact external mailbox and fixed contact@ alias**. Analytics and preview rows never enable a beacon or change `preview_deployment_setting` by themselves. SEO and redirect rows never publish HTML/robots/sitemap or create Page Rules. Preview opt-in requires acknowledging that draft links can be public. Turnstile contact forms stay Siteverify-plan-only until the separate #89 cost/privacy gate. Migrations `0007` and `0009` expand allowed kinds. Stored rows remain review records, not authority for a Cloudflare or GitHub mutation.

## Applying the reviewed domain or email

The former PR #121 direct `POST /site-options-apply` implementation has been retired in the new code because a stored approval alone did not have a separate operator-authorization and atomic execution claim. Calls to that old endpoint now fail closed with 403. This is a security reconciliation, not a second consent screen.

An **Apply operator-approved domain/email** button appears on the **same toolkit page** only if an operator independently approved a second, exact matching D1 execution row and the feature release flags are explicitly enabled. The new `0006_option_executions.sql` ledger binds the stored request's ID, digest, normalized reviewed payload, current GitHub user, Cloudflare account, repository ID, Pages project, source SHA and session authorization epoch. Its atomic `approved → applying → applied` transition has a one-winner lease and no automatic replay after unknown provider outcome. No public endpoint creates an execution grant.

Domain execution attaches only the approved hostname to the matching currently verified, owner-owned Cloudflare Pages project. No app DNS/MX/name-server API calls are made. **Cloudflare Pages itself may automatically create DNS records in a zone that the owner controls**, so this operation requires an explicit operator review; do not promise that the customer's zone is untouched. Never change the platform's `360web.cloud` apex/www/mail records or other sites.

Email execution additionally requires a matching **applied** domain execution, currently active Pages domain, ready Email Routing/DNS on an active owner zone, existing verified forwarding mailbox and nonconflicting `contact@hostname` alias. The app creates only the exact forwarding rule; it never writes MX, offers a sending mailbox, or initiates mailbox verification.

Forms remain review-only until a separate #89 cost/privacy authorization, customer D1 and server-side Siteverify Worker with independent acceptance; a widget is not a working form.

Visitor insights, PR preview, SEO, and redirect requests stay store-only until a later operator-approved enablement. Preview enablement also requires Access review because draft URLs can be public. SEO still needs verified-origin evidence plus an owner-reviewed Git PR; redirects still need Domain-approved DNS/Page Rule configuration.

## Hosted status and release

PR #121's prior Worker was reported deployed and its direct route may **still be present on the hosted Worker** until Domain #2 explicitly authorizes deployment of this safer replacement. Merging code alone does not change the running Worker. **Do not run the hosted `0006` D1 migration, deploy the Worker, add email OAuth scopes, or enable feature flags without Domain #2 / Sol #83 review.** The new code is disabled by default and tests no longer authorize stored-only domain writes. #53 onboarding redesign is untouched and #21 customer test has not been run.

Detailed operator/execution contract: [APPROVED_EXTENSION_CONSUMER.md](APPROVED_EXTENSION_CONSUMER.md).
