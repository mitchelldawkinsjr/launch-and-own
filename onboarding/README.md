# Launch & Own — hosted onboarding service

The Worker in this directory is deployed as a **hosted browser beta** at **https://onboard.360web.cloud**. Domain/OAuth has verified GitHub and Cloudflare user consent, account selection, TLS, and both public OAuth apps. A real customer-backed GitHub repository and exact approved Cloudflare Pages production deployment have **not yet passed independent acceptance**; see [Issue #21](https://github.com/mitchelldawkinsjr/launch-and-own/issues/21).

Its customer journey: connect GitHub, connect Cloudflare, choose an account, **create a one-page website or upload a static ZIP**, inspect the exact preview, separately approve resource creation, and verify the approved GitHub commit plus public file bytes. The hosted ZIP beta has passed a real owner-consented 5/5-file launch ([#45](https://github.com/mitchelldawkinsjr/launch-and-own/issues/45#issuecomment-7087063896)); an independent customer launch is still pending.

## Operator setup

1. The dedicated **Launch & Own beta D1** (`launch-and-own-onboarding-beta`) is provisioned and has **migrations 0001–0004 applied** and recorded in the ordered ledger. Its nonsecret UUID is set in `wrangler.jsonc`. Do not reapply migrations from old setup notes; verify the actual ledger and required schema. Never reuse a customer's contact-form database or the older prototype D1.
2. Run `npm run preflight:onboarding` to verify the local configuration. To verify live database identity and schema with a read-scoped provider token, run `CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... node onboarding/validate-config.mjs --remote`. Do not store tokens in source.
3. The **public GitHub App** and **verified public Cloudflare OAuth client** have already been registered with exact HTTPS callbacks. Existing users may need to reaccept newly granted GitHub Repository creation or Pull requests permissions. Review actual provider consent before modifying app registration or scope.
4. Configure Worker bindings `ONBOARDING_ORIGIN`, `GH_CLIENT_ID`, `CF_CLIENT_ID`, `CF_SCOPES`, and secrets `TOKEN_ENCRYPTION_KEY`, `GH_CLIENT_SECRET`, and `CF_CLIENT_SECRET`. The encryption key needs 32 random bytes encoded as 64 hex characters.
5. Install/authorize Cloudflare's **separate** Workers & Pages GitHub App for the customer's repository; product GitHub consent alone cannot grant access.
6. **Disconnect:** the hosted Worker deletes the local session and attempts to revoke its GitHub OAuth grant and Cloudflare access token. If either provider cannot confirm revocation, it displays a warning to review connected apps in both providers. This does not uninstall the GitHub App or remove the customer's websites. Continue independent live provider-revocation, launch recovery, retention and abuse checks in [#21](https://github.com/mitchelldawkinsjr/launch-and-own/issues/21) and [#12](https://github.com/mitchelldawkinsjr/launch-and-own/issues/12).
7. Verify an independent customer's OAuth consent, launch approval, private repository, Pages deployment, and exact GitHub revision.

**Current production configuration:** The Domain agent reports an active Worker Custom Domain/TLS, registered provider apps and required secrets, public app consent, live OAuth account selection, and D1 migrations **0001–0004**. The `/health` readiness check confirms the launch-job schema, not an independently successful customer website launch. Revalidate the current release against the remote D1 before any future deployment; coordinate on [Issue #2](https://github.com/mitchelldawkinsjr/launch-and-own/issues/2).

Customer login and launch approval are separate actions. Never paste provider tokens into chat or commit them to GitHub.

## Selected beta onboarding hostname

The approved onboarding origin is **`https://onboard.360web.cloud`**. GitHub callback: `https://onboard.360web.cloud/oauth/github/callback`; Cloudflare callback: `https://onboard.360web.cloud/oauth/cloudflare/callback`. The other agent owns the Cloudflare zone, Worker Custom Domain and OAuth provider app settings. The old `onboard.mitchelldawkins.com` URL is **not** an approved alternative. Domain has since verified the sole Worker Custom Domain, HTTPS and the public OAuth redirects for `onboard.360web.cloud`. This does **not** prove the GitHub repository/Pages launch flow works end to end. Coordinate with [domain handoff](../docs/HANDOFF_DOMAIN_OAUTH.md), and do not edit live DNS as part of backend changes.

## Secure disconnect behavior

`POST /logout` is CSRF-protected. It removes the encrypted local session **before** sending best-effort revocation calls to GitHub and Cloudflare. GitHub uses its OAuth grant revocation API; Cloudflare uses the OAuth revocation endpoint. A provider outage cannot leave the customer signed into the onboarding Worker. The UI distinguishes confirmed revocation from locally signed-out but **unconfirmed remote revocation** and advises the user to review provider-connected applications. App installation permissions are distinct from user OAuth grants and may still require separate removal.

Provider tokens and errors are never echoed to the browser or logged. See `onboarding/revoke-connections.test.mjs` and `onboarding/worker.test.mjs` for success, outage and cross-session regressions.


## Expiring OAuth tokens and refresh-token rotation

`onboarding/migrations/0002_token_rotation.sql` adds **encrypted refresh credentials** and independent expiry/refresh leases for GitHub and Cloudflare. Apply this migration **once** to the dedicated Launch & Own beta D1 before deploying any Worker code from this change. Do not apply it to customer contact-form databases.

The Worker now preserves `refresh_token` / `expires_in` returned from GitHub and Cloudflare authorization, encrypts them using per-session contextual AES-GCM, and renews expiring access tokens before provider API actions. It uses an atomic, short-lived D1 lease to avoid concurrent use of a one-time rotating token; renewal updates both encrypted access and refresh tokens together. An expired or missing refresh credential results in an explicit *reconnect* requirement, not a silent bypass or reuse of expired credentials. Provider errors remain server-side only.

**Provider registration detail:** GitHub App user tokens should be configured to expire (GitHub supports `offline_access` and rotating refresh tokens). The Cloudflare OAuth client must support `refresh_token` as an allowed grant type to return refresh credentials. Without an available refresh credential, the user must reauthorize when the access token expires. The `onboarding_sessions` cookie still expires after one hour; refresh handling does not create indefinite login sessions or unattended authorization.

**Before any future deployment:** verify all four migrations in the dedicated product-owned D1, `npm test`, the remote preflight, actual provider scopes/grants, and a coordinated QA window. Live owner OAuth and token rotation have been checked by Domain/OAuth; provisioning, full revocation behavior and exact public-site deployment still require separate customer acceptance.


## Durable launch recovery

`onboarding/migrations/0004_launch_jobs.sql` adds a durable job table and a short-lived link to the approving session. Approval stores the plan, exact HTML, digest and verified account identities in one transaction. The existing five-minute Cron claims due jobs, resumes from provider checkpoints and verifies the production GitHub SHA and public HTML. Disconnection, session expiry, and provider authorization failures pause further work. After reconnecting the same accounts, the customer can review and explicitly reapprove the original website to resume the same job.

See the [architecture and rollout guide](../docs/DURABLE-LAUNCH-ARCHITECTURE.md) for the authorization model, retry behavior, dedicated D1 migration, operator checks and rollback. Coordinate the migration and deployment with the backend owner. The Worker health check reports `launchJobsReady` when it can query the new schema.

## Business website preview and approval

The website-only beta now accepts a business/site name, homepage headline, about text, up to six services, an optional contact email and a supported color theme. The user can open a session-protected `GET /site-preview?id=...` after submitting their details. This preview renders the exact static HTML that `applyWebsite()` will put in `public/index.html` **after** an explicit approval; unapproved previews never create repositories or Pages projects. The template is responsive, accessible, script-free and performs strict length/email/theme validation and HTML escaping. It uses no remote fonts, images or trackers.

A safe retry compares the source HTML with the approved preview. The generated site is a single homepage. Use a website ZIP to publish a built site with multiple pages and assets.

## Upload a built website

After connecting GitHub and selecting Cloudflare, choose **Upload a built website**. Upload a ZIP with a UTF-8 `index.html` at its root or in one enclosing build folder. Include the HTML, styles, scripts and assets from your static build output. The upload accepts ZIPs up to 6 MiB with at most 128 files, 8 MiB total expanded size and 2 MiB per file. Supported files use portable ASCII names. The importer checks archive metadata and file contents and rejects paths outside the website, conflicting names, links, encrypted archives and Pages configuration files.

The review shows the complete file list, private GitHub repository and public Pages address. Open the private preview to navigate the uploaded pages with their original local assets. HTTPS CDNs (scripts, stylesheets, fonts, images) are allowed so common static exports render; forms, framing and service workers stay blocked. Approval covers the file paths and bytes in the reviewed bundle. The GitHub App commits `public/` in one atomic branch update and records the verified tree's commit SHA before requesting Pages. Pages builds from `public/` with an empty build command. The launch reaches **live** when Cloudflare reports that production SHA and serves the exact approved homepage.

### Operator rollout

1. Coordinate the rollout with the Domain/OAuth agent. Designate a dedicated preview zone with proxied wildcard DNS and a matching TLS certificate for `*.<preview-domain>`. Production uses the sibling form `ZIP_PREVIEW_DOMAIN=-zp.360web.cloud`: previews live at `<artifact-id>-zp.360web.cloud`, covered by the free `*.360web.cloud` certificate, routed by `*-zp.360web.cloud/*` to `launch-and-own-zip-preview` (`onboarding/wrangler.preview.jsonc`) behind a proxied `*.360web.cloud` DNS record. Previews are therefore same-site with other `360web.cloud` hosts; onboarding stays protected by exact-Origin checks, CSRF tokens and host-only `__Host-` cookies. Route only those preview hosts to a separate Worker with `zip-preview-worker.mjs` as its entrypoint, `nodejs_compat` enabled and `workers.dev` and preview URLs disabled. Each upload uses its own hostname, so root-relative assets retain their paths and customer scripts run outside the onboarding origin.
2. Create a dedicated private R2 bucket in the Workers account. Keep public access disabled. Set lifecycle expiration for `website-zip/draft/` after one day and `website-zip/approved/` after 32 days. The approved lifecycle covers the existing 30-day recovery window, including a promotion that precedes the final D1 write.
3. Bind the bucket as `ZIP_ARTIFACTS` to both Workers. Set `ZIP_PREVIEW_DOMAIN` to the bare preview domain and provide the same independent 32-byte hex `ZIP_PREVIEW_KEY` secret on both. Set the preview Worker's `ONBOARDING_ORIGIN` to the exact registered onboarding origin. Give the preview Worker only its preview bindings. Keep OAuth grants, the onboarding encryption key and D1 on the onboarding Worker.
4. Confirm the GitHub App can write repository contents through `createCommitOnBranch`. Confirm the customer's separate Cloudflare Pages GitHub App can read the created repository. Test with a consenting beta account and a small synthetic ZIP before enabling general access. Verify a script and root-relative asset on the private preview, check that a bare preview URL returns 404, and confirm the exact production commit after approval.
5. Measure invocation CPU in hosted Worker logs for upload, approval and job execution with a representative ZIP near the advertised limits. Compare each stage with the selected Workers plan's HTTP and Cron CPU limits. [Workers CPU limits](https://developers.cloudflare.com/workers/platform/limits/#cpu-time)

The upload option appears once its preview bindings are configured. The approved bundle manifest is recorded in the existing job plan, so this feature uses the current D1 schema. `npm test` covers the ZIP flow with simulated providers, including loss of a commit response, authorization expiry and reapproval. Hosted acceptance requires the preview zone, storage lifecycle and provider checks above.


## Approved launch history

`GET /history` requires the same verified GitHub identity and Cloudflare account. It lists durable jobs and remaining legacy receipts for up to 30 days from first approval. History contains private website copy and may contain a contact email. A customer can delete completed or inactive history while keeping their GitHub repository and Pages site.

Legacy approvals can be reviewed and reapproved from history before they enter the durable runner. See the [retention and rollout guide](../docs/DURABLE-LAUNCH-ARCHITECTURE.md#retention-and-rollout) for cleanup, backup retention and privacy policy requirements.

## Optional AI-generated editable copy (no automatic publication)

The onboarding page offers a **Draft my website copy** form only when both an AI binding named `AI` and a supported model identifier in `SITE_AI_MODEL` are provided by the authorized operator. The owner-controlled `onboarding/wrangler.jsonc` is **not** modified by this feature; coordinate the binding/model addition with the domain/OAuth agent on [PR #7](https://github.com/mitchelldawkinsjr/launch-and-own/pull/7) and obtain explicit owner approval for inference costs and privacy before enabling it. Current Cloudflare guidance describes Workers AI binding `env.AI.run(model, request)` and JSON schema mode: https://developers.cloudflare.com/workers-ai/configuration/bindings/ and https://developers.cloudflare.com/workers-ai/features/json-mode/.

The customer **opts in per draft** by submitting a business name and 20–1400-character description, and may choose a theme and contact email. Only the business name and description are sent to Workers AI. OAuth tokens, user IDs, selected Cloudflare account IDs and contact emails are **not** sent to the model. The model is asked to return structured `tagline`, `about` and `services` text. Untrusted model output is parsed, length/schema-validated and HTML-escaped; no arbitrary HTML, scripts or externally sourced URLs are published. The resulting fields are presented in an **editable** form; the existing `POST /preview` and `POST /approve` remain separate mandatory steps. Until a customer previews and approves a plan, **no persistent launch record, GitHub repository, Pages project or site deployment is created by the draft endpoint**.

The manual website editor is always available when AI is absent, expensive, unavailable or gives invalid output. The AI provider is only called on an explicit, CSRF-validated, rate-limited `POST /draft`; it is never invoked on routine page visits, retries or Cron. AI text may still contain hallucinations, so the customer must review every claim, service and optional contact detail before publication. The complete AI feature has mocked-provider tests but **no live Workers AI binding, production inference test or cost approval** yet. Do not claim the public beta has AI generation enabled until those checks pass.


## Wrangler D1 migration history integrity

On **November 21, 2026**, the dedicated product D1 had the complete physical schema from migrations `0001_initial.sql`, `0002_token_rotation.sql`, and `0003_launch_receipts.sql` (four tables, five application indexes, eight refresh-token columns), but Wrangler's `d1_migrations` registry was empty because the earlier schemas had been applied directly. After verifying the live D1 UUID/name, table/column/index schema, and no existing tracking rows, the backend workstream reconciled **only the three Wrangler tracking names**, without re-executing schema migrations. All three are now verified in `d1_migrations`.

**This is a one-time reconciliation, not a migration strategy.** For future schema changes:

1. Add a new, numbered `.sql` migration file in `onboarding/migrations/` and review its effect on tenant data.
2. Confirm the target database is specifically `launch-and-own-onboarding-beta` in the correct Cloudflare account.
3. Apply the migration through Wrangler's D1 migration command in the `onboarding/` directory, under an authorized operator connection; verify the result.
4. Run `npm run preflight:onboarding` and the read-only remote preflight with dedicated Cloudflare credentials, supplied through environment variables rather than files or GitHub comments.
5. Remote preflight checks the **exact identity**, the required schema and cleanup trigger, and the **complete ordered Wrangler migration ledger** against the SQL filenames in this repository. It probes the durable job columns without reading customer rows. Missing, reordered, unexpected or unrecorded migrations fail closed.

Never re-run existing `ALTER TABLE` migrations or manually add tracking names unless an authorized operator has independently confirmed the matching physical schema and a reviewed, incident-specific recovery plan. The preflight **never modifies** database schema or migration history.

Cloudflare documentation: https://developers.cloudflare.com/d1/reference/migrations/.
