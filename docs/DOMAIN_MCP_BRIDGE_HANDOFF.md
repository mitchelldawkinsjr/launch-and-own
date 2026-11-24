# Domain handoff — MCP bridge Worker + D1

**Issue:** [#43](https://github.com/mitchelldawkinsjr/launch-and-own/issues/43). **Coordination:** [#2](https://github.com/mitchelldawkinsjr/launch-and-own/issues/2).

Domain has deployed the shared MCP bridge and verified owner-only connections. Independent acceptance still gates the distribution matrix. Use this checklist for further approved rollouts. [Deployed bridge evidence](https://github.com/mitchelldawkinsjr/launch-and-own/issues/43#issuecomment-7104228298)

## What is already in the repo

| Piece | Path | Status |
| --- | --- | --- |
| Tool contract + transport | `integration/tool-contract.mjs`, `bridge-transport.mjs` | Merged; CI-tested |
| Memory adapters | `*-store.mjs` | Test-only |
| D1 schema + adapters | `integration/migrations/`, `d1-agent-token-store.mjs`, `d1-owner-link-store.mjs`, `d1-site-draft-store.mjs`, `d1-job-publication-store.mjs` | Ready in repo; Domain creates DB + applies migrations |
| Worker entry | `integration/bridge-worker.mjs` | Returns **503** unless `BRIDGE_DEPLOYMENT=approved` |
| Wrangler | `integration/wrangler.bridge.jsonc` | Hosted at `mcp.360web.cloud`; D1 `384a87b9-…08465` |
| Browser link consume | `POST /mcp/link/browser` | Accepts **sealed onboarding ticket** only |

## Hard safety rules

1. **Do not** deploy with `BRIDGE_DEPLOYMENT=approved` until this checklist is complete and the owner authorizes the window.
2. **Do not** reintroduce agent-bearer `/mcp/link/complete` with a caller-supplied `verified` map (#71).
3. **Do not** put GitHub/Cloudflare tokens in D1 rows returned to models.
4. Keep bridge D1 **separate** from customer contact-form databases and prefer a dedicated `launch-and-own-mcp-bridge` D1 (not the onboarding beta DB) until a deliberate shared-tenant design is reviewed.
5. Coordinate any `onboarding/worker.mjs` ticket-mint route with draft PRs [#31](https://github.com/mitchelldawkinsjr/launch-and-own/pull/31) / [#53](https://github.com/mitchelldawkinsjr/launch-and-own/pull/53).

## Domain operator steps

### A–B. Infrastructure + smoke (done 2026-11-22)

1. ~~Create D1~~ `launch-and-own-mcp-bridge` → `384a87b9-8f7c-4477-acbd-29d0c5d08465`
2. ~~Migrations applied~~ (`0001_bridge.sql` remote)
3. ~~Hostname~~ `https://mcp.360web.cloud` (custom domain; `workers_dev` false)
4. ~~Secrets~~ matching `BRIDGE_TICKET_KEY` on bridge + onboarding Workers
5. ~~Onboarding var~~ `BRIDGE_ORIGIN=https://mcp.360web.cloud`
6. Smoke (redacted): `not_approved` → metadata/tools **503**; `approved` → metadata **200**, tools without bearer **401**, forged `{ticket,verified}` → **400** `invalid_link_challenge`; `/agent-link` serves connect prompt; onboarding `/health` ok

Customer matrix access remains **`not_available`** until consenting-user `/agent-link` E2E + OAuth client registration + #21/#55 review.

### C. Browser link mint (onboarding)

Domain has verified the hosted owner-account flow through `GET|POST /agent-link` (`onboarding/agent-link.mjs`). Check that the current deployments still share the approved ticket key before updating either Worker. [Owner MCP evidence](https://github.com/mitchelldawkinsjr/launch-and-own/issues/43#issuecomment-7089818896)

1. Customer is already signed into `onboard.360web.cloud` with GitHub **and** selected Cloudflare account.
2. Agent `start_connect_accounts` hands off to `/agent-link?challenge_id=…`.
3. Customer confirms (CSRF). Onboarding **mints** a short-lived sealed ticket with `BRIDGE_TICKET_KEY` using **session** GitHub user + Cloudflare account only.
4. Onboarding Worker `POST`s `{ticket}` to `BRIDGE_ORIGIN/mcp/link/browser` (no agent Bearer; challenge row supplies subject/client).
5. Bridge unseals ticket, runs D1 `consumeLinkChallenge`, returns safe linked projection.

Operator secrets/vars on **onboarding** Worker (in addition to bridge):

- Secret `BRIDGE_TICKET_KEY` — **same** 64-hex value as the bridge Worker
- Var `BRIDGE_ORIGIN` — exact HTTPS origin of the bridge host (e.g. `https://mcp.360web.cloud`)

### D. MCP protocol + OAuth (bridge is its own authorization server)

MCP clients connect to `https://mcp.360web.cloud/mcp` (Streamable HTTP, JSON responses, `integration/mcp-jsonrpc.mjs`). Unauthenticated requests get `401` with `WWW-Authenticate: Bearer resource_metadata=…`, which starts the client's OAuth flow (`integration/oauth-server.mjs`):

| Endpoint | Purpose |
| --- | --- |
| `/.well-known/oauth-protected-resource` (and `/mcp` suffix) | RFC 9728; `authorization_servers: [https://mcp.360web.cloud]` |
| `/.well-known/oauth-authorization-server` | RFC 8414 metadata |
| `POST /register` | RFC 7591 dynamic registration, public clients only; https or loopback-http redirects |
| `GET/POST /authorize` | Human consent page; PKCE S256 required; same-origin POST only |
| `POST /token` | Code exchange (single use) and rotating refresh tokens |
| `POST /revoke` | Revoke a client’s access token or end its refresh grant and bridge owner link |

The OAuth grant identifies an **agent session only** (fresh opaque subject). GitHub/Cloudflare identity still binds only through `start_connect_accounts` → `/agent-link` → sealed ticket. Apply `migrations/0002_oauth.sql` to the bridge D1 before deploying. No GitHub/Cloudflare OAuth scope changes.

Connect a client: `claude mcp add --transport http launch-and-own https://mcp.360web.cloud/mcp`, or add the same URL as a ChatGPT connector (developer mode).

### Bridge security rollout

Apply `0003_oauth_rate_limits.sql` to the dedicated bridge D1 before deploying the hardened Worker. The Worker requires persistent D1 state and the shared ticket key. The migration adds bounded rate buckets for public OAuth routes and indexes for grant revocation. The buckets store a keyed slot rather than the source address. The protected resource stays the registered bridge origin.

OAuth parses bounded JSON and URL-encoded bodies. MCP checks an Origin header when a browser supplies one, and server-to-server clients can omit it. Code exchange and refresh rotation each claim the old credential and insert both replacement tokens in one D1 batch. A failed insert lets the authorized client retry the same credential. A refresh grant revocation ends its access and refresh tokens, cancels outstanding link challenges, and removes the bridge owner link. This does not revoke the owner's separately stored GitHub or Cloudflare session.

After the approved deploy, smoke-test discovery, dynamic registration, the browser consent redirect, PKCE exchange, MCP initialize and tools/list, and revocation with a consenting QA client. Confirm oversized requests fail before parsing and unexpected browser origins receive 403. Roll back the Worker to the prior approved version if client or tenant checks fail. The migration is additive. [Security review #157](https://github.com/mitchelldawkinsjr/launch-and-own/issues/157)

### D2. Agent draft → owner review → launch (#43 item 5)

1. `request_explicit_approval` / `get_exact_preview` hand the owner `https://onboard.360web.cloud/review?draft=<draft_id>`.
2. Onboarding (signed-in owner) seals a **draft ticket** with the session's GitHub user + Cloudflare account and calls `POST BRIDGE_ORIGIN/mcp/internal/draft`. Bridge returns the draft only if owner matches, kind `create`, still `prepared` and unexpired.
3. Onboarding re-renders it and requires `sha256(renderSite(...)) === preview_sha256`. It stages one preview per browser session, selected owner and draft, with the current authorization epoch checked in the same write. Approve → launch → verify use the existing onboarding steps.
4. Agents poll `get_job_status` or `verify_publication` with `job_id = draft_id`. Onboarding reads unexpired launch records for the exact GitHub user and Cloudflare account with a current owner session. The bridge rechecks the calling token and linked owner before returning the response. A previously verified publication returns `last_verified` with a Unix timestamp in seconds and the then-verified commit and HTML digests. Current public bytes require a fresh production check.

The calls use separate ticket purposes and expire after 60 seconds. The status endpoint accepts up to 4 KiB of JSON on the registered onboarding origin. Provider tokens stay on their originating service.

For an approved rollout of status handoff version 2, Domain deploys the bridge first and then onboarding. The upgraded bridge returns `onboarding_status_unavailable` during a version mismatch. Verify the historical status fields and a revoked or expired session with a consenting QA owner. Roll back both Workers together. No D1 migration is required for version 2.

### D3. Optional discovery metadata rollout

Custom ChatGPT apps can use the packaged PNG directly where their settings allow it. A bridge rollout serves the description and same-origin PNG to clients that read MCP server metadata. [Branding instructions](../clients/chatgpt/README.md)

For a bridge rollout, Domain confirms the live Worker version and the exact candidate source. The last reported bridge version is `5629e23b` from `0b9bcce`. Review the #138 status-handoff changes in the candidate and confirm the paired onboarding version before approving the rollout. [Bridge deployment](https://github.com/mitchelldawkinsjr/launch-and-own/issues/43#issuecomment-7104228298) · [#138](https://github.com/mitchelldawkinsjr/launch-and-own/pull/138) · [Onboarding deployment](https://github.com/mitchelldawkinsjr/launch-and-own/issues/2#issuecomment-7117559538)

After an approved deployment, verify OAuth discovery, owner-authorized MCP initialize and tool listing, and the advertised PNG's origin, content type, and bytes. Confirm the owner link and draft/status handoff with the authorized QA account. Roll back to the recorded bridge version if the checks fail.

### E. Release gates

Only after independent consenting-user QA:

1. Orchestration updates `distribution/release-matrix.json` access/verification for `shared_mcp_api`.
2. Connected Claude/ChatGPT claims stay blocked until that matrix change + #55/#2 review.

## Rollback

1. Set `BRIDGE_DEPLOYMENT=not_approved` (instant 503) or remove custom domain route.
2. Do not delete D1 until owner confirms; export redacted row counts for incident notes if needed.
