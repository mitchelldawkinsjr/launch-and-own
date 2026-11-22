# Shared agent MCP/API contract — v1 (not deployed)

**Scope:** contract-first, transport-neutral validation and mock/negative-path QA for [#43](https://github.com/mitchelldawkinsjr/launch-and-own/issues/43) and [#55](https://github.com/mitchelldawkinsjr/launch-and-own/issues/55). The source is [`integration/tool-contract.mjs`](../integration/tool-contract.mjs); run `node --test integration/tool-contract.test.mjs`. **This is not an MCP server, connector, HTTP endpoint, authenticated OAuth implementation or publisher.** It has no network, D1, GitHub, Cloudflare or Worker side effects.

## One API, multiple entry points

Portable skills, Claude and ChatGPT integrations must use the **same authenticated backend** once released. The standalone browser at https://onboard.360web.cloud must continue to work independently of AI. Model output is untrusted site input, not a provider authorization, approval or proof of a live deployment. This module deliberately exports no `publish` action.

Proposed operation names (not currently callable by customers or agents):

| Operation | Required arguments | Contract intent |
| --- | --- | --- |
| `get_connection_status` | None | Return safe linked/unlinked status from the trusted owner-link store |
| `start_connect_accounts` | None | Present a **generic** hosted browser entry point; real challenge creation remains a server+browser capability |
| `list_sites` | None | Tenant-scoped, durable inventory (not only 30-day receipts) |
| `get_site` | `site_id` | Return allowlisted owner/site metadata after record ownership check |
| `prepare_site` | `site_spec` | Validate bounded structured content and prepare a frozen artifact; no provider creation |
| `prepare_site_update` | `site_id`, `base_commit_sha`, `changes` | Use latest owner-verified managed source and reject stale base or changed repository |
| `get_exact_preview` | `draft_id` | Retrieve server-rendered exact artifact digest; never show a rough design as a deployable preview |
| `request_explicit_approval` | `draft_id`, `preview_sha256`, `idempotency_key` | **Request** a separate human browser review, not approval or publication |
| `get_job_status` | `job_id` | Return truthful scoped job state, including reauthorization |
| `verify_publication` | `job_id` | Only return `live` after trusted production commit AND public content verification |

All tools reject unknown arguments, including model-supplied owner/account/credentials. Model-provided `site_spec` is limited to name, headline, about, up to six services, optional contact email and current one-page theme. This is **initial contract input only**, not ZIP ingest, dynamic code execution, arbitrary HTML or form provisioning. The existing browser ZIP workflow remains separately gated by its own validation and private preview. Tool names and arguments may require an explicitly versioned migration before real client registration.

## Required authenticated transport (must implement separately)

1. Implement a distinct **MCP protected resource** and its protected-resource metadata; follow the current [MCP authorization specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization) and [security guidance](https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices). Validate issuer, audience/resource, token lifetime and scope **before** processing a tool; reject token passthrough to GitHub/Cloudflare. `BRIDGE_AUDIENCE` in the helper is a **provisional internal marker**, not a real registered resource identifier.
2. Trusted middleware reconstructs `principal` from authenticated server state. The model **cannot supply** `authenticated`, `subject`, `linkedOwner`, provider IDs, epochs, or user grants in tool arguments. The contract validator does **not** perform cryptographic token verification.
3. Owner linking requires a short-lived, one-time, collision-resistant challenge bound to the authenticated agent **subject and client ID**. For first-time linking there is no previously known provider identity; the browser must verify both GitHub user and selected Cloudflare account through OAuth and then transactionally bind them to the subject. For **reconnection**, the challenge additionally pins the previously linked provider identities; mismatches fail closed. The browser consumes the challenge transactionally. `assertLinkChallenge` only checks resulting trusted records for subject/client mismatch, expiry, prior consumption and (when present) expected provider IDs; it does **not** generate or consume OAuth codes or challenges.
4. Store linked identities and authorization epochs server-side. Every site/draft/job read must be scoped in the database query to the owner and **again** checked via `assertOwnedRecord`. Do not trust guessable IDs or only a session cookie. Account switching, disconnect or revoked grants must invalidate outstanding authority; replaying a prior epoch must fail.
5. Never return access tokens, refresh tokens, OAuth codes, link-state, grants, raw customer HTML, private ZIP bytes or private session IDs to model context. Use explicit response projections rather than serializing database/provider objects. `publicationStatus` and `humanApprovalHandoff` are illustrative safe projections, **not** proof that the backend performed the verification.

## Immutable preview and human approval

- Prepare renders the **exact deterministic artifact** server-side, records immutable bytes/revision and SHA-256 digest, selected provider accounts, target repo/project names and relevant costs/quotas. Preview expiry is bounded. Do not silently regenerate from LLM input after the customer reviews.
- `assertPreparedDraft` checks owner/epoch, exact digest, expiry and (for updates) fresh canonical branch SHA and immutable repository ID. This is a local fence only: the real adapter must fetch current provider facts and reject out-of-band changes. Do not use the original 30-day launch receipt as current editable source; coordinate with [#39](https://github.com/mitchelldawkinsjr/launch-and-own/issues/39) and draft [#31](https://github.com/mitchelldawkinsjr/launch-and-own/pull/31).
- A requested approval returns only a known hosted browser destination (`/review`) and safe digest, **not** a signed approval, auth state, URL token or provider mutation. Browser must authenticate the same customer, render exact bytes/targets/costs, confirm CSRF and separate affirmative approval, and compare the immutable digest again.
- The browser backend, **not an agent tool**, records durable consent and starts the existing D1 job runner. `idempotency_key` must be persisted and compared under the owner+draft scope so retries cannot create a second site. This contract only validates its shape.
- For update, require approved feature PR and owner-controlled merge; do not write directly to `main` or claim a pending PR is a live site.

## Status, trust and release boundaries

- `queued`, `pending_deployment`, `needs_reauthorization` and `failed` are **not** `live`. To return `live`, verify canonical production commit SHA, exact approved public HTML SHA-256 and the intended project/target in a trusted provider adapter. Proof booleans in the sample record must be derived by that verifier, **never** copied from model arguments.
- Do not expose sensitive failure diagnostics or private content. Use stable public reason codes (`unauthenticated`, `needs_reauthorization`, `not_found`, `stale_preview`, `stale_source`, `invalid_arguments`) and keep richer data in restricted, redacted service logs.
- Automated tests exercise a **mock contract boundary** (mismatched owner, expired token/link, stale SHA, replayed link marker, digest substitution, unsafe URLs, invalid model fields, false live proof). They are not real client installs, OAuth linking, hosted MCP transport, provider publishing or consenting-customer acceptance.
- Keep `distribution/release-matrix.json` unchanged while this module remains non-deployed; `shared_mcp_api`, connected Claude and ChatGPT remain **not available**. No plugin distribution, production Worker deployments, OAuth permission changes or customer-account mutations are authorized by this PR.

## Next implementation slice for #43

Create an **isolated authenticated transport + owner linking** against the same existing backend, with a verified MCP resource identifier and protected-resource metadata. Add tenant-filtered read-only site inventory (reconcile long-term #39 identities), real immutable draft/preview storage and server-side approval handoff. Then bind durable job status/verification to the existing D1 runner. Run negative tests at the HTTP boundary (wrong audience, unlinked subject, expired link, different provider account, stale source, revoked authorization and replay), provider-backed QA with one **independent consenting** user, and release review through #2/#55. Refrain from touching `onboarding/worker.mjs` until #31/#53 integration and Domain window are coordinated.
