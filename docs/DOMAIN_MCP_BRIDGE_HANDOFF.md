# Domain handoff — MCP bridge Worker + D1 (not live yet)

**Issue:** [#43](https://github.com/mitchelldawkinsjr/launch-and-own/issues/43). **Coordination:** [#2](https://github.com/mitchelldawkinsjr/launch-and-own/issues/2).

This document is the **operator checklist** to take the in-repo MCP bridge from “merged / not_available” to a Domain-approved hosted beta. Code alone must not flip `BRIDGE_DEPLOYMENT=approved` or the distribution matrix to hosted access.

## What is already in the repo

| Piece | Path | Status |
| --- | --- | --- |
| Tool contract + transport | `integration/tool-contract.mjs`, `bridge-transport.mjs` | Merged; CI-tested |
| Memory adapters | `*-store.mjs` | Test-only |
| D1 schema + adapters | `integration/migrations/`, `d1-owner-link-store.mjs`, `d1-site-draft-store.mjs`, `d1-job-publication-store.mjs` | Ready in repo; Domain creates DB + applies migrations |
| Worker entry | `integration/bridge-worker.mjs` | Returns **503** unless `BRIDGE_DEPLOYMENT=approved` |
| Wrangler | `integration/wrangler.bridge.jsonc` | `workers_dev: false`; D1 binding placeholder |
| Browser link consume | `POST /mcp/link/browser` | Accepts **sealed onboarding ticket** only |

## Hard safety rules

1. **Do not** deploy with `BRIDGE_DEPLOYMENT=approved` until this checklist is complete and the owner authorizes the window.
2. **Do not** reintroduce agent-bearer `/mcp/link/complete` with a caller-supplied `verified` map (#71).
3. **Do not** put GitHub/Cloudflare tokens in D1 rows returned to models.
4. Keep bridge D1 **separate** from customer contact-form databases and prefer a dedicated `launch-and-own-mcp-bridge` D1 (not the onboarding beta DB) until a deliberate shared-tenant design is reviewed.
5. Coordinate any `onboarding/worker.mjs` ticket-mint route with draft PRs [#31](https://github.com/mitchelldawkinsjr/launch-and-own/pull/31) / [#53](https://github.com/mitchelldawkinsjr/launch-and-own/pull/53).

## Domain operator steps

### A. Create infrastructure (Cloudflare)

1. Create D1 database `launch-and-own-mcp-bridge` in the same account as onboarding.
2. Put the real `database_id` into `integration/wrangler.bridge.jsonc` → `d1_databases[0].database_id` (replace `REPLACE_WITH_BRIDGE_D1_ID`).
3. Apply migrations:  
   `cd integration && npx wrangler d1 migrations apply launch-and-own-mcp-bridge --remote -c wrangler.bridge.jsonc`
4. Choose a hostname (proposal: `mcp.360web.cloud` or `bridge.360web.cloud`). Add custom domain / route; keep `workers_dev` and preview URLs **false**.
5. Create secrets (32-byte hex each, distinct from onboarding `TOKEN_ENCRYPTION_KEY` where noted):
   - `BRIDGE_TICKET_KEY` — seals browser link tickets (must match the key onboarding will use to **mint** tickets)
   - Optional later: agent token signing material if you replace opaque DB tokens
6. Set vars only after approval window:
   - `ONBOARDING_ORIGIN=https://onboard.360web.cloud`
   - `BRIDGE_ORIGIN=https://<chosen-host>`
   - `BRIDGE_DEPLOYMENT=not_approved` for the first deploy smoke; flip to `approved` only after smoke + owner OK

### B. First deploy smoke (still not customer-facing)

1. Deploy Worker from `integration/` with wrangler using `wrangler.bridge.jsonc`.
2. Confirm `GET https://<host>/.well-known/oauth-protected-resource` returns **503** while `not_approved`, then **200** only after approved flag.
3. Confirm `POST /mcp/tools/call` without bearer → 401; with forged link body → no link mutation.
4. Record redacted evidence on #43 (no secrets).

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

### D. MCP OAuth resource registration

1. Register protected resource metadata URL: `https://<host>/.well-known/oauth-protected-resource`
2. Align audience with production `BRIDGE_AUDIENCE` / resource URI (replace provisional `launch-and-own-mcp` marker before public clients).
3. Do not expand GitHub/Cloudflare OAuth scopes without owner authorization.

### E. Release gates

Only after independent consenting-user QA:

1. Orchestration updates `distribution/release-matrix.json` access/verification for `shared_mcp_api`.
2. Connected Claude/ChatGPT claims stay blocked until that matrix change + #55/#2 review.

## Rollback

1. Set `BRIDGE_DEPLOYMENT=not_approved` (instant 503) or remove custom domain route.
2. Do not delete D1 until owner confirms; export redacted row counts for incident notes if needed.
