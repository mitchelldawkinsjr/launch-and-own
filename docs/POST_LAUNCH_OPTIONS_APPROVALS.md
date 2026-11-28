# Post-launch stored option requests — #88

The `/site-options` toolkit page lets a verified owner review and store separate hostname, forwarding-email, forms, visitor-insights (Web Analytics), scoped PR-preview, and same-host redirect requests. Each request recomputes its digest server-side. Email fingerprints include the **exact external mailbox and fixed contact@ alias**. Preview opt-in requires acknowledging that draft links can be public. Turnstile forms require a separate #89 cost/privacy gate before staging. Migrations `0007` and `0009` expand allowed kinds, including the legacy SEO starter request. Provider writes require the corresponding enablement or publication approval.

## Applying the reviewed domain or email

The former PR #121 direct `POST /site-options-apply` implementation has been retired in the new code because a stored approval alone did not have a separate operator-authorization and atomic execution claim. Calls to that old endpoint now fail closed with 403. This is a security reconciliation, not a second consent screen.

An **Apply operator-approved domain/email** button appears on the **same toolkit page** only if an operator independently approved a second, exact matching D1 execution row and the feature release flags are explicitly enabled. The new `0006_option_executions.sql` ledger binds the stored request's ID, digest, normalized reviewed payload, current GitHub user, Cloudflare account, repository ID, Pages project, source SHA and session authorization epoch. Its atomic `approved → applying → applied` transition has a one-winner lease and no automatic replay after unknown provider outcome. No public endpoint creates an execution grant.

Domain execution attaches only the approved hostname to the matching currently verified, owner-owned Cloudflare Pages project. No app DNS/MX/name-server API calls are made. **Cloudflare Pages itself may automatically create DNS records in a zone that the owner controls**, so this operation requires an explicit operator review; do not promise that the customer's zone is untouched. Never change the platform's `360web.cloud` apex/www/mail records or other sites.

Email execution additionally requires a matching **applied** domain execution, currently active Pages domain, ready Email Routing/DNS on an active owner zone, existing verified forwarding mailbox and nonconflicting `contact@hostname` alias. The app creates only the exact forwarding rule; it never writes MX, offers a sending mailbox, or initiates mailbox verification.

Forms remain review-only until a separate #89 cost/privacy authorization, customer D1 and server-side Siteverify Worker with independent acceptance; a widget is not a working form.

**Turn on SEO starter** opens the exact file review directly when site-file activation is enabled. The owner approves the proposed additions against the reviewed GitHub revision. Existing search engine files are listed in the review, and a site with both files needs no publishing action. Previously saved SEO requests still open through their existing links.

Visitor insights and PR preview requests use their separate enablement flows. Preview enablement requires Access review because draft URLs can be public. Same-host redirects need a saved rule for file review. Apex/www redirects require Domain-approved configuration.

## Hosted status and release

Domain reported the onboarding beta on `b2fecc3` with migrations through `0010`. Forms and email execution remain gated. The newer per-site toolkit and Analytics review require the independent #21 walkthrough and a separate Domain release window. For live execution, review the exact stored request and operator grant before selecting any feature flag or provider rollout. [Domain report](https://github.com/mitchelldawkinsjr/launch-and-own/issues/2#issuecomment-7117559538)

Detailed operator/execution contract: [APPROVED_EXTENSION_CONSUMER.md](APPROVED_EXTENSION_CONSUMER.md).
