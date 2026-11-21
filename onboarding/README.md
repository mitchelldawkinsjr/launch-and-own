# Launch & Own — hosted onboarding service

The Worker in this directory is an **unconfigured beta source template**, not an active production OAuth login.

Its customer journey: connect GitHub, connect Cloudflare, choose an account, review a website, approve resource creation, and verify the exact approved GitHub commit in Cloudflare production.

## Operator setup

1. A new **Launch & Own beta D1** (`launch-and-own-onboarding-beta`) has been created, and `migrations/0001_initial.sql` was applied. Its nonsecret UUID is set in `wrangler.jsonc`. Never reuse customer contact-form databases or the older prototype D1.
2. Run `npm run preflight:onboarding` to verify the local configuration. To verify live database identity and schema with a read-scoped provider token, run `CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... node onboarding/validate-config.mjs --remote`. Do not store tokens in source.
3. Register a GitHub App and Cloudflare OAuth client with minimal privileges and exact HTTPS callback URLs on a domain you control.
4. Configure Worker bindings `ONBOARDING_ORIGIN`, `GH_CLIENT_ID`, `CF_CLIENT_ID`, `CF_SCOPES`, and secrets `TOKEN_ENCRYPTION_KEY`, `GH_CLIENT_SECRET`, and `CF_CLIENT_SECRET`. The encryption key needs 32 random bytes encoded as 64 hex characters.
5. Install/authorize Cloudflare's **separate** Workers & Pages GitHub App for the customer's repository; product GitHub consent alone cannot grant access.
6. **Disconnect:** the hosted Worker deletes the local session and attempts to revoke its GitHub OAuth grant and Cloudflare access token. If either provider cannot confirm revocation, it displays a warning to review connected apps in both providers. This does not uninstall the GitHub App or remove the customer's websites. Refresh-token rotation, durable job retries, retention, abuse prevention and a security review remain necessary before public beta.
7. Verify an independent customer's OAuth consent, launch approval, private repository, Pages deployment, and exact GitHub revision.

The beta database identity and schema have been verified against Cloudflare. This does **not** mean the Worker or OAuth login is deployed; OAuth app registrations, verified callback domain, and Worker secrets remain outstanding.

Customer login and launch approval are separate actions. Never paste provider tokens into chat or commit them to GitHub.

## Selected beta onboarding hostname

The approved onboarding origin is **`https://onboard.360web.cloud`**. GitHub callback: `https://onboard.360web.cloud/oauth/github/callback`; Cloudflare callback: `https://onboard.360web.cloud/oauth/cloudflare/callback`. The other agent owns the Cloudflare zone, Worker Custom Domain and OAuth provider app settings. The old `onboard.mitchelldawkins.com` URL is **not** an approved alternative. Domain checks currently report zone status `pending` and an existing proxied CNAME at the target hostname, so HTTPS/public routing is **not yet verified**. Coordinate with [domain handoff](../docs/HANDOFF_DOMAIN_OAUTH.md), and do not edit live DNS as part of backend changes.

## Secure disconnect behavior

`POST /logout` is CSRF-protected. It removes the encrypted local session **before** sending best-effort revocation calls to GitHub and Cloudflare. GitHub uses its OAuth grant revocation API; Cloudflare uses the OAuth revocation endpoint. A provider outage cannot leave the customer signed into the onboarding Worker. The UI distinguishes confirmed revocation from locally signed-out but **unconfirmed remote revocation** and advises the user to review provider-connected applications. App installation permissions are distinct from user OAuth grants and may still require separate removal.

Provider tokens and errors are never echoed to the browser or logged. See `onboarding/revoke-connections.test.mjs` and `onboarding/worker.test.mjs` for success, outage and cross-session regressions.


## Expiring OAuth tokens and refresh-token rotation

`onboarding/migrations/0002_token_rotation.sql` adds **encrypted refresh credentials** and independent expiry/refresh leases for GitHub and Cloudflare. Apply this migration **once** to the dedicated Launch & Own beta D1 before deploying any Worker code from this change. Do not apply it to customer contact-form databases.

The Worker now preserves `refresh_token` / `expires_in` returned from GitHub and Cloudflare authorization, encrypts them using per-session contextual AES-GCM, and renews expiring access tokens before provider API actions. It uses an atomic, short-lived D1 lease to avoid concurrent use of a one-time rotating token; renewal updates both encrypted access and refresh tokens together. An expired or missing refresh credential results in an explicit *reconnect* requirement, not a silent bypass or reuse of expired credentials. Provider errors remain server-side only.

**Provider registration detail:** GitHub App user tokens should be configured to expire (GitHub supports `offline_access` and rotating refresh tokens). The Cloudflare OAuth client must support `refresh_token` as an allowed grant type to return refresh credentials. Without an available refresh credential, the user must reauthorize when the access token expires. The `onboarding_sessions` cookie still expires after one hour; refresh handling does not create indefinite login sessions or unattended authorization.

**Before deployment:** verify `0002` migration on the product-owned D1, `npm test`, the exact provider scopes/grants, and the real callback/refresh/revocation flows with a consenting beta account. This is CI-tested against simulated endpoints, **not** live OAuth acceptance.


## Bounded recovery of approved website launches

The onboarding Worker now has a **five-minute Cron Trigger** (`onboarding/wrangler.jsonc`) to recover work if an approved provisioning request is interrupted. It looks for:

- **Stale `provisioning` records** older than five minutes, only while the approving customer's encrypted session is valid. It reuses the existing idempotent provisioning path and refuses unrelated customer-owned resources.
- **`pending_deployment` records** older than 90 seconds, checking the **exact expected production GitHub SHA** before changing status to `live`.

Each Cron pass handles at most five records. A preview-only, failed, unapproved, or expired-session launch is **never** automatically provisioned; failed launches still require the customer's explicit retry. Provider failures remain generic and leave a safe status for a later check.

**Important limit:** this is *bounded recovery*, not a durable job queue across session expiry. Sessions currently expire after one hour, and the cleanup process may remove their associated launch records. A persistent user/account authorization model, independent job runner, explicit retention policy and long-lived job history are required before promising hands-off multi-day retries or perpetual maintenance. Cron is not active until the isolated Worker is deployed by the domain/onboarding operator.

Acceptance tests simulate a crashed provisioning call, a stale deployment SHA, a subsequent matching deployment, expired sessions and failed-job no-retry behavior.

## Business website preview and approval

The website-only beta now accepts a business/site name, homepage headline, about text, up to six services, an optional contact email and a supported color theme. The user can open a session-protected `GET /site-preview?id=...` after submitting their details. This preview renders the exact static HTML that `applyWebsite()` will put in `public/index.html` **after** an explicit approval; unapproved previews never create repositories or Pages projects. The template is responsive, accessible, script-free and performs strict length/email/theme validation and HTML escaping. It uses no remote fonts, images or trackers.

A safe retry against an existing customer repository compares the stored HTML with the approved preview and refuses to reuse a different page. Existing customer files are never overwritten. This feature does not yet generate bespoke AI design, multi-page navigation, upload images, collect contact-form submissions or manage custom domains. Future AI-assisted content drafts must still be previewed and approved by the customer before publishing.
