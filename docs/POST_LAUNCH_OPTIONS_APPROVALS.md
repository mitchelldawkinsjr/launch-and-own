# Post-launch stored option requests — #88

The `/site-options` toolkit page lets a verified owner review and turn on optional features. For owner-enabled custom domains, email forwarding, visitor insights, and contact forms, the final action records the reviewed choices and starts the authorized workflow in one submission. The review binds the exact live site revision and settings to the current owner session. Older saved requests and operator-approved workflows retain their existing endpoints.

## Applying the reviewed domain or email

The former PR #121 direct `POST /site-options-apply` implementation has been retired in the new code because a stored approval alone did not have a separate operator-authorization and atomic execution claim. Calls to that old endpoint now fail closed with 403. This is a security reconciliation, not a second consent screen.

An **Apply operator-approved domain/email** button appears on the **same toolkit page** only if an operator independently approved a second, exact matching D1 execution row and the feature release flags are explicitly enabled. The new `0006_option_executions.sql` ledger binds the stored request's ID, digest, normalized reviewed payload, current GitHub user, Cloudflare account, repository ID, Pages project, source SHA and session authorization epoch. Its atomic `approved → applying → applied` transition has a one-winner lease and no automatic replay after unknown provider outcome. No public endpoint creates an execution grant.

Domain execution attaches only the approved hostname to the matching currently verified, owner-owned Cloudflare Pages project. No app DNS/MX/name-server API calls are made. **Cloudflare Pages itself may automatically create DNS records in a zone that the owner controls**, so this operation requires an explicit operator review; do not promise that the customer's zone is untouched. Never change the platform's `360web.cloud` apex/www/mail records or other sites.

Email execution additionally requires a matching **applied** domain execution, currently active Pages domain, ready Email Routing/DNS on an active owner zone, existing verified forwarding mailbox and nonconflicting `contact@hostname` alias. The app creates only the exact forwarding rule; it never writes MX, offers a sending mailbox, or initiates mailbox verification.

Contact form setup requires Cloudflare's form permissions and the #89 cost and privacy acknowledgment. After provisioning, the separate site-file review connects the form to the Worker.

**Turn on SEO starter** opens the exact file review directly when site-file activation is enabled. The owner approves the proposed additions against the reviewed GitHub revision. Existing search engine files are listed in the review, and a site with both files needs no publishing action. Previously saved SEO requests still open through their existing links.

The visitor insights review checks Pages for an existing analytics tag and shows the beacon disclosure before activation. Private preview requests are recorded after the owner acknowledges that draft links can be public. Enabling previews requires separate Access review. Same-site redirects go directly from the two paths to exact `_redirects` file review and explicit approval. Apex/www redirects require separate Cloudflare configuration.

## Hosted status and release

Domain reported the onboarding beta on `b2fecc3` with migrations through `0010`. Forms and email execution remain gated. The newer per-site toolkit and Analytics review require the independent #21 walkthrough and a separate Domain release window. For live execution, review the exact stored request and operator grant before selecting any feature flag or provider rollout. [Domain report](https://github.com/mitchelldawkinsjr/launch-and-own/issues/2#issuecomment-7117559538)

Detailed operator/execution contract: [APPROVED_EXTENSION_CONSUMER.md](APPROVED_EXTENSION_CONSUMER.md).
