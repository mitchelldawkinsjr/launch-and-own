# Launch & Own — hosted onboarding service

The Worker in this directory is an **unconfigured beta source template**, not an active production OAuth login.

Its customer journey: connect GitHub, connect Cloudflare, choose an account, review a website, approve resource creation, and verify the exact approved GitHub commit in Cloudflare production.

## Operator setup

1. Create an independent Cloudflare D1 database. Never use a customer's contact-form database.
2. Replace the invalid ID in `wrangler.jsonc`, then apply `migrations/0001_initial.sql`.
3. Register a GitHub App and Cloudflare OAuth client with minimal privileges and exact HTTPS callback URLs on a domain you control.
4. Configure Worker bindings `ONBOARDING_ORIGIN`, `GH_CLIENT_ID`, `CF_CLIENT_ID`, `CF_SCOPES`, and secrets `TOKEN_ENCRYPTION_KEY`, `GH_CLIENT_SECRET`, and `CF_CLIENT_SECRET`. The encryption key needs 32 random bytes encoded as 64 hex characters.
5. Install/authorize Cloudflare's **separate** Workers & Pages GitHub App for the customer's repository; product GitHub consent alone cannot grant access.
6. Review refresh-token expiry and rotation, disconnect/revocation, durable job retries, retention, abuse prevention, and tenant isolation before public beta.
7. Verify an independent customer's OAuth consent, launch approval, private repository, Pages deployment, and exact GitHub revision.

With the placeholder configuration, `node onboarding/validate-config.mjs` is **expected to fail safely** until an independent D1 UUID is set.

Customer login and launch approval are separate actions. Never paste provider tokens into chat or commit them to GitHub.
