# Launch & Own — hosted onboarding service

The Worker in this directory is an **unconfigured beta source template**, not an active production OAuth login.

Its customer journey: connect GitHub, connect Cloudflare, choose an account, review a website, approve resource creation, and verify the exact approved GitHub commit in Cloudflare production.

## Operator setup

1. A new **Launch & Own beta D1** (`launch-and-own-onboarding-beta`) has been created, and `migrations/0001_initial.sql` was applied. Its nonsecret UUID is set in `wrangler.jsonc`. Never reuse customer contact-form databases or the older prototype D1.
2. Run `npm run preflight:onboarding` to verify the local configuration. To verify live database identity and schema with a read-scoped provider token, run `CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... node onboarding/validate-config.mjs --remote`. Do not store tokens in source.
3. Register a GitHub App and Cloudflare OAuth client with minimal privileges and exact HTTPS callback URLs on a domain you control.
4. Configure Worker bindings `ONBOARDING_ORIGIN`, `GH_CLIENT_ID`, `CF_CLIENT_ID`, `CF_SCOPES`, and secrets `TOKEN_ENCRYPTION_KEY`, `GH_CLIENT_SECRET`, and `CF_CLIENT_SECRET`. The encryption key needs 32 random bytes encoded as 64 hex characters.
5. Install/authorize Cloudflare's **separate** Workers & Pages GitHub App for the customer's repository; product GitHub consent alone cannot grant access.
6. Review refresh-token expiry and rotation, disconnect/revocation, durable job retries, retention, abuse prevention, and tenant isolation before public beta.
7. Verify an independent customer's OAuth consent, launch approval, private repository, Pages deployment, and exact GitHub revision.

The beta database identity and schema have been verified against Cloudflare. This does **not** mean the Worker or OAuth login is deployed; OAuth app registrations, verified callback domain, and Worker secrets remain outstanding.

Customer login and launch approval are separate actions. Never paste provider tokens into chat or commit them to GitHub.
