# Agent handoff: `*.360web.cloud` domain and OAuth setup for Launch & Own

**Project:** [Launch & Own](https://github.com/mitchelldawkinsjr/launch-and-own) — *Describe it. Launch it. Own it.*  
**Tracking:** [Beta launch issue #2](https://github.com/mitchelldawkinsjr/launch-and-own/issues/2)  
**Owner of this handoff:** agent responsible for `360web.cloud`, its Cloudflare zone, and provider-application registration  
**As of:** November 21, 2026 (revised after approved hostname switch)  
**Status:** Ready for authorized domain/app setup. **Do not interpret this handoff as approval to publish a public OAuth app or expose a customer login service.**

## Objective and exact hostname

Prepare **`https://onboard.360web.cloud`** as the dedicated **Launch & Own onboarding application** hostname. This is the currently selected hostname for the beta. The previous `onboard.mitchelldawkins.com` hostname is retired from this plan; do not register OAuth callbacks or routes there. Use the same exact HTTPS origin across the Worker, GitHub App, Cloudflare OAuth client, and callback registrations.

`*.360web.cloud` in this task means **work within the domain/zone**, not creation of a wildcard DNS record or `*/*` Worker route. **Only claim the single host `onboard.360web.cloud`.** Do not change `360web.cloud` apex, `www`, other subdomains, domain nameservers, mail records, or unrelated websites.

**Requested URL contract:**

| Purpose | Exact value |
| --- | --- |
| Onboarding application | `https://onboard.360web.cloud/` |
| GitHub user-authorization callback | `https://onboard.360web.cloud/oauth/github/callback` |
| Cloudflare authorization callback | `https://onboard.360web.cloud/oauth/cloudflare/callback` |
| Read-only health endpoint | `https://onboard.360web.cloud/health` |
| Worker environment origin | `ONBOARDING_ORIGIN=https://onboard.360web.cloud` |
| Worker script | `launch-and-own-onboarding-beta` |
| Cloudflare zone | `360web.cloud` |
| Relevant repository | `mitchelldawkinsjr/launch-and-own` |

The proposed hostname and exact callback paths match `onboarding/worker.mjs`. Do **not** configure callbacks on `www`, `launch`, or `workers.dev` in place of the HTTPS origin above.

## Current verified state (read this before making changes)

- **Current Cloudflare read-only audit:** The `360web.cloud` zone is **pending**, not active. Its nameserver/ownership verification must be completed before production proxying; do not claim it is live.
- A **proxied CNAME already exists** for `onboard.360web.cloud`, pointing to `360web.cloud`. Do **not** overwrite it without the zone agent's authorization and a documented safe cutover. It may conflict with attachment of a Worker Custom Domain. Recheck live state before any change.
- **Domain agent owns resolving both blockers:** zone activation and the existing DNS record's intended use/removal/replacement. Backend agent should not alter either.
- The reusable product lives at `mitchelldawkinsjr/launch-and-own`; `Brittney-Site` is an **independent customer reference**, not the platform hosting target.
- `onboarding/wrangler.jsonc` has the existing beta Worker name and a **dedicated, already created/migrated** D1 binding: `launch-and-own-onboarding-beta` with UUID `b89fb8aa-67a2-49fa-b48c-584e305b5bb2`. The application migration has three onboarding tables and three indexes, confirmed in Cloudflare. **Do not create a second database or point this Worker at Brittney's database.**
- The Worker implementation exists in `onboarding/worker.mjs`, but the hosted OAuth application has **not been publicly deployed or live accepted**.
- The Cloudflare connector currently available to the other development agent returned **HTTP 403** when listing account OAuth clients. Registration likely needs account Super Administrator, Administrator, or `OAuth Clients Write` access. Do not ask anyone to paste a secret into chat.
- `main` CI tests are passing for the source-code beta, but that does not establish an actual OAuth login.

## Ownership split

**Your agent owns (domain / provider app):**

- Check domain/zone state, collision-free hostname allocation, HTTPS and certificate readiness.
- Set up the **Worker Custom Domain** for the single hostname when the backend operator confirms the Worker is ready and the owner approves the exposure.
- Register the **Launch & Own GitHub App** and the **Cloudflare OAuth client** with the exact callbacks; coordinate confidential app credentials securely with the Worker operator.
- Create the **exact Cloudflare OAuth publisher-verification TXT** supplied by Cloudflare for its client URL, then confirm verified ownership.
- Configure/confirm the nonsecret `ONBOARDING_ORIGIN` value on the Worker side if you have deployment responsibility. Otherwise provide the exact value to the backend agent.
- Report nonsecret IDs, app slug, scope names, verification and endpoint statuses in the repo issue/PR.

**The product/backend agent owns (do not take over):**

- OAuth/PKCE code, D1 session/launch logic, encrypted secret handling, refresh-token lifecycle, API permissions verification, rollout safety and beta acceptance.
- Customer GitHub repository provisioning, Cloudflare Pages, future contact forms, exact-commit deploy verification.
- GitHub Actions tests, PR review and source changes outside the narrowly required domain/configuration integration.

If domain-side or backend-side work is blocked by missing permission, **stop and record the blocker**; do not broaden access or switch the target account.

## Required tasks, in order

### 1. Reserve and audit the hostname

- [ ] Verify you control the Cloudflare zone for `360web.cloud` **and activate it** (currently pending). Follow the zone's actual nameserver/verification setup; do not change unrelated zones.
- [ ] Audit the existing **proxied CNAME `onboard.360web.cloud` → `360web.cloud`**, plus any Worker routes/Custom Domains. Determine its ownership and intended purpose before a controlled correction; never delete or replace it blindly.
- [ ] Choose the single Custom Domain `onboard.360web.cloud` for **`launch-and-own-onboarding-beta`**, not a wildcard subdomain.
- [ ] Verify that the hostname is not currently used by an unrelated service or certificate setup.
- [ ] Record a before/after snapshot of relevant DNS name/type and Worker routing *without* leaking private zone export contents.

**Preferred Cloudflare method:** attach a **Worker Custom Domain**. Cloudflare creates the required DNS record and TLS certificate automatically. Do **not** manually add an arbitrary A/AAAA/CNAME to guess the Worker endpoint. A Custom Domain may conflict with the existing CNAME; stop and investigate before attaching it. Also wait for `360web.cloud` to become active before claiming HTTPS/proxy readiness. Do not attach a public route until deployment readiness and owner approval.

Docs: https://developers.cloudflare.com/workers/configuration/routing/custom-domains/

### 2. Register the GitHub App (owner's approval required for permissions)

- [ ] In the authorized GitHub account, register a **GitHub App** named **Launch & Own** (or a distinct, clearly labeled beta variant if the name is unavailable).
- [ ] Set homepage URL to `https://onboard.360web.cloud/`.
- [ ] Register **exact** user-authorization callback: `https://onboard.360web.cloud/oauth/github/callback`.
- [ ] Request the minimum permissions required for the current user-to-server flow: **Repository creation** and **Contents read/write** for permitted repositories. Confirm the actual API operations using the live beta rather than granting broad administration. The existing provisioner calls `GET /user`, `POST /user/repos`, repository content reads/writes, and branch reads.
- [ ] Record the GitHub App **Client ID**, app ID/name/slug, installation/visibility settings, and callback URI in the *private operator handoff*. Client secret must be installed directly into the secure Worker secret store as `GH_CLIENT_SECRET`, never in GitHub source, issues, chat or a public PR.
- [ ] Decide which beta testers can install/authorize the app; test with a separate authorized account. **GitHub App installation/permissions and user OAuth authorization are distinct.**
- [ ] Note a separate requirement: **Cloudflare's own Workers & Pages GitHub integration** must be authorized for the customer repository; our product's GitHub App cannot grant that access by itself.

GitHub references:
- https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-user-authorization-callback-url
- https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app
- https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app

### 3. Register Cloudflare OAuth client and verify domain

- [ ] Log into the intended Cloudflare account with **OAuth Clients Write** (or equivalent admin role). Previous connector attempts to inspect clients returned HTTP 403; escalate if this persists.
- [ ] Create an OAuth client named **Launch & Own**. For the existing Worker backend, use **Authorization Code** and the exact registered redirect `https://onboard.360web.cloud/oauth/cloudflare/callback`.
- [ ] Set the client/application URL to `https://onboard.360web.cloud/`. Use the chosen confidential-client token authentication method compatible with `pipeline/cloudflare-oauth.mjs` (client secret via HTTP Basic, i.e. `client_secret_basic`) and PKCE S256.
- [ ] Inspect **current official Cloudflare OAuth scopes** for listing/selecting an authorized account and creating/reading Pages projects. Verify exact scope IDs against Cloudflare's scope catalog and API permissions **before** assigning `CF_SCOPES`. Do not guess names, request unnecessary all-account privileges, or broaden scopes just to make the test pass.
- [ ] Save **CF_CLIENT_ID** as a nonsecret Worker setting; install **CF_CLIENT_SECRET** directly into the secure Worker secret store. Do not put secrets in a commit or issue.
- [ ] When Cloudflare provides the domain-publisher verification challenge, add the **exact TXT record name/value** given by Cloudflare under `360web.cloud`. Preserve the full `cloudflare_oauth_client_publisher=` prefix and record the result (never invent a fixed TXT token or hostname).
- [ ] Wait for verification to report success and retain a nonsecret screenshot/status reference. Verify the application name, logo, client URL and requested scopes on the consent screen.
- [ ] **Stop before promoting the client to public visibility**. Cloudflare public promotion is *irreversible*. Obtain explicit product-owner authorization and ensure consent copy, privacy/terms materials, scope limits and the live service have been reviewed. A private client initially works only for members of the parent Cloudflare account, not arbitrary outside customers.

Cloudflare references:
- https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/
- https://developers.cloudflare.com/fundamentals/oauth/integrate-with-cloudflare/

### 4. Coordinate a controlled onboarding Worker deployment

The code lives in `onboarding/` and uses `onboarding/wrangler.jsonc`. **Do not redeploy the Brittney form Worker, its Access policy or customer Pages project.**

- [ ] Confirm with the backend agent that the following bindings are ready (no secrets in a public issue):

| Binding | Meaning / owner |
| --- | --- |
| `ONBOARDING_ORIGIN` | **`https://onboard.360web.cloud`**, exact HTTPS origin, no trailing slash |
| `DB` | Existing dedicated `launch-and-own-onboarding-beta` D1 |
| `ONBOARDING_LIMITER` | Configured Worker rate limiter |
| `GH_CLIENT_ID` | GitHub App Client ID |
| `GH_CLIENT_SECRET` | **Secret** installed server-side |
| `CF_CLIENT_ID` | Cloudflare OAuth Client ID |
| `CF_CLIENT_SECRET` | **Secret** installed server-side |
| `CF_SCOPES` | Verified minimal Cloudflare OAuth scope IDs, space-separated |
| `TOKEN_ENCRYPTION_KEY` | **Secret**: 32 random bytes / 64 hexadecimal characters, generated and stored server-side |

- [ ] Backend CI: `npm test` and `npm run preflight:onboarding` succeed. The Worker is **not** ready merely because the D1 schema exists.
- [ ] Only after owner approval, deploy the isolated Worker to the approved account and attach the single Custom Domain `onboard.360web.cloud`. Confirm Cloudflare-generated DNS, TLS and correct Worker routing.
- [ ] Verify `GET https://onboard.360web.cloud/health` returns HTTP 200 with JSON `ok: true, configured: true` (a configuration health check, **not** evidence of OAuth or provisioning acceptance).
- [ ] Verify `GET https://onboard.360web.cloud/` serves a Launch & Own onboarding page over HTTPS. Verify it uses `Secure` / `HttpOnly` cookies during browser OAuth testing.
- [ ] If adding Cloudflare Access protections, confirm GitHub and Cloudflare callback redirects remain reachable; an Access login wall may break cross-provider callbacks. Consult backend before enabling.
- [ ] Do not expose broad public onboarding while provider refresh/revocation, abuse controls and second-customer acceptance remain unverified. Use the approved beta rollout restrictions.

### 5. Validate redirects and hand control back to the product agent

- [ ] GitHub authorization starts at `/connect/github` and returns **only** to the GitHub callback registered above; state and PKCE are consumed once and tied to the login cookie.
- [ ] Cloudflare authorization starts at `/connect/cloudflare` for a signed-in customer and returns **only** to the Cloudflare callback above; state/PKCE are verified.
- [ ] Confirm invalid/mismatched or reused callback state does not authenticate a user.
- [ ] Confirm selected account is the customer's own authorized Cloudflare account.
- [ ] Confirm HTTPS redirect and TLS certificate validity with no mixed-content or redirect loops.
- [ ] Hand off the nonsecret connection statuses to the product agent for the **independent customer** launch/verification test. The product agent, not the domain agent, confirms repository creation, Pages deployment and exact GitHub commit.
- [ ] Record any remaining blockers: account permission, custom-domain collision, missing scope, Pages GitHub integration, callback restrictions, or public-consent approval.

## Must-not-do list

- **Do not create wildcard DNS `*.360web.cloud` or wildcard Worker routes.**
- **Do not modify apex `360web.cloud`, `www`, mail DNS, other subdomains, or unrelated sites.**
- **Do not alter `Brittney-Site`, its Worker, Turnstile, D1, Access policy, production deploy, or Git connection.**
- **Do not publish the Cloudflare OAuth client as public without explicit owner approval** (irreversible action).
- **Do not turn on unrestricted customer signup or claim customer launch is complete** after a health check or sample homepage.
- **Do not store provider secrets, verification tokens, raw OAuth codes, browser cookies, or credentials in public GitHub commits/issues/PR comments/chat.** The Cloudflare TXT challenge is a DNS verification proof; enter only the exact issued challenge directly in DNS.
- **Do not change billing or take over repositories/accounts you do not own.**
- **Do not confuse the customer's Pages GitHub App installation with the Launch & Own GitHub App OAuth consent.**

## Return report required from the domain agent

Post a concise **nonsecret** completion note in [Issue #2](https://github.com/mitchelldawkinsjr/launch-and-own/issues/2), or a dedicated PR linking back to this document, with:

| Item | What to report |
| --- | --- |
| Hostname | Exact hostname chosen and whether the owner approved public exposure |
| DNS / TLS | Custom Domain attached? DNS record automatically generated? HTTPS certificate valid? |
| Worker | Script name, environment, deployment status (do not post secret values) |
| GitHub App | App name/slug, public client ID if permitted, callback URI, requested permissions, status |
| Cloudflare OAuth | Client name, nonsecret client ID if permitted, callback URI, requested scopes, private/public state |
| Domain verification | TXT challenge **verified / pending / blocked**; do not paste its full challenge into a public issue |
| Endpoint checks | `/health` response and `/` HTTPS status, without cookies or tokens |
| Browser consent | GitHub and Cloudflare redirect tests: passed / blocked / not attempted |
| Outstanding approvals | Clearly note any irreversible/public visibility approval still needed |
| Changed artifacts | Links to approved GitHub PRs and Cloudflare resources, not credentials |
| Handoff result | **ready for backend acceptance**, **partially complete**, or **blocked** |

**Definition of done for this agent:** an **active** `360web.cloud` zone, safe handling of the pre-existing `onboard` CNAME, a controlled HTTPS onboarding hostname, correctly registered OAuth callbacks, verified DNS ownership, documented scope/permission configuration, and a precise nonsecret status report. **This does not mean the whole Launch & Own product has completed a real customer launch.**

## Reusable agent starting prompt

> You are the Launch & Own **domain and OAuth infrastructure agent**. Read `docs/HANDOFF_DOMAIN_OAUTH.md`, `onboarding/README.md`, `onboarding/wrangler.jsonc`, `onboarding/worker.mjs`, and Issue #2 in `mitchelldawkinsjr/launch-and-own`. Own only the `onboard.360web.cloud` domain/TLS/Cloudflare OAuth publisher verification and the named GitHub/Cloudflare app registrations. Follow the checklist, stop at explicit owner-approval boundaries, do not expose secrets or alter Brittney's deployment. Make any code/config changes through a reviewed PR, then post the requested nonsecret report in Issue #2. Escalate permissions or irreversible public OAuth promotion instead of guessing or proceeding silently.
