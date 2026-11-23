# Domain handoff — MCP bridge Worker + D1 (not live yet)

**Issue:** [#43](https://github.com/mitchelldawkinsjr/launch-and-own/issues/43). **Coordination:** [#2](https://github.com/mitchelldawkinsjr/launch-and-own/issues/2).

This document is the **operator checklist** to take the in-repo MCP bridge from “merged / not_available” to a Domain-approved hosted beta. Code alone must not flip `BRIDGE_DEPLOYMENT=approved` or the distribution matrix to hosted access.

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

In-repo: `GET|POST /agent-link` (`onboarding/agent-link.mjs`). Still needs Domain secrets before it works in production.

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

The OAuth grant identifies an **agent session only** (fresh opaque subject). GitHub/Cloudflare identity still binds only through `start_connect_accounts` → `/agent-link` → sealed ticket. Apply `migrations/0002_oauth.sql` to the bridge D1 before deploying. No GitHub/Cloudflare OAuth scope changes.

Connect a client: `claude mcp add --transport http launch-and-own https://mcp.360web.cloud/mcp`, or add the same URL as a ChatGPT connector (developer mode).

### E. Release gates

Only after independent consenting-user QA:

1. Orchestration updates `distribution/release-matrix.json` access/verification for `shared_mcp_api`.
2. Connected Claude/ChatGPT claims stay blocked until that matrix change + #55/#2 review.

## Rollback

1. Set `BRIDGE_DEPLOYMENT=not_approved` (instant 503) or remove custom domain route.
2. Do not delete D1 until owner confirms; export redacted row counts for incident notes if needed.
