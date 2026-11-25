# ADR-001: How the assistant gets deployed into the customer's Cloudflare account

- **Status:** Proposed. Needs Domain/OAuth sign-off (Domain owns provider permissions under AGENTS.md).
- **Blocks:** M0 decision "Cloudflare scopes" in #165
- **Date:** 2026-11-24 · Claude Opus 5.5

## Context

`onboarding/wrangler.jsonc` sets `CF_SCOPES` to `account-settings.read page.read page.write zone.read zone-settings.read dns.read email-routing-address.read email-routing-rule.read email-routing-rule.write email-routing-account-rule.read offline_access`.

The assistant needs a Worker script, a D1 database, a Workers AI binding, secrets and an Access application in the customer's account. #165 says "do not expand OAuth scopes" without separate approval.

**Verified:** wrangler 4.168.0's scope table has `workers_scripts:write`, `d1:write`, `ai:write`, `secrets_store:write` and `offline_access`. It has **no scope for Access or Zero Trust**.

**What this does and doesn't prove.** It shows that the scopes *wrangler* requests can't configure Access. It doesn't show which scopes Cloudflare allows *third-party* OAuth clients such as Launch & Own's own client (`CF_CLIENT_ID`) to request. That eligibility is **unverified**, and Domain should confirm it with Cloudflare before anyone relies on options A or D. Until then, this ADR treats Access setup as a customer step in every option, because that's the only path we've confirmed.

## Options

### A. Expand Launch & Own's OAuth scopes
Add `workers_scripts:write`, `d1:write` and `ai:write` to the existing client. Launch & Own then deploys the assistant using the stored, refreshable token.
- **For:** the smoothest UX, and it reuses the hosted flow.
- **Against:**
  - Launch & Own would hold a durable token (`offline_access`) that can write code into the Workers of **every** connected account. A breach of Launch & Own becomes code execution in customer accounts.
  - It contradicts "no durable central credential dependency".
  - It needs a Domain scope review, and existing users would have to consent again.
  - It doesn't cover Access through any scope we've verified.

### B. Customer-run deploy (recommended)
The customer deploys from their own private assistant repo (ADR-003), using either:
- **B1, CLI:** `wrangler login`, which uses Cloudflare's own OAuth client, so the token stays on the customer's machine. Then `wrangler d1 create`, `wrangler d1 migrations apply --remote`, `wrangler secret put` and `wrangler deploy`.
- **B2, the customer's own CI:** a workflow in the private assistant repo, using a Cloudflare API token the customer creates. It needs only Workers Scripts Edit, D1 Edit and Workers AI on that one account, stored as a repo secret.

- **For:**
  - Launch & Own scopes stay unchanged, and Launch & Own never holds a credential for the assistant.
  - It works with Launch & Own offline, and the customer's consent is explicit in every command.
  - Updates (ADR-004) use the same path.
- **Against:**
  - CLI friction. Wrangler 4.168 needs Node ≥ 22.12.
  - B2 requires the customer to create an API token by hand, so the guide needs exact steps.

### C. A Cloudflare deploy button or template flow
A browser flow run by Cloudflare that copies the template into the customer's GitHub and sets up builds. It's customer-run, so Launch & Own scopes stay unchanged.
- **For:** no CLI.
- **Against:** what it currently does is **unverified**: whether it creates D1 from the config, how secrets are set, and how it pins versions. Evaluate it in M3 as a UX layer over B.

### D. A separate one-time "installer" OAuth client
A second Launch & Own OAuth client with the expanded scopes and **no** `offline_access`. Its token is used in-session for one deploy and then discarded.
- **For:** a hosted UX with no durable token.
- **Against:**
  - Launch & Own still handles a token that can write Workers during setup, so a compromised Launch & Own could still deploy malicious code at that moment.
  - It needs a Domain review and a second client registration.
  - It doesn't cover Access through any scope we've verified.
  - Unverified: whether third-party clients can request these scopes at all.

## Decision (proposed)

**Use B for M2: the CLI (B1) as the reference path, with B2 documented.** Launch & Own `CF_SCOPES` stay exactly as they are.

- Access is a guided manual step, with a dashboard deep link and the exact policy. The Worker **fails closed** until the Access team domain and AUD are configured and a valid JWT arrives (see the threat model, bootstrap section).
- Evaluate C for M3 once its behaviour is verified.
- Consider D only if the M1.5/M2 evidence shows unacceptable drop-off in the CLI path, and only after a Domain scope review. A is rejected.

## CLI prototype vs guided setup for nontechnical DIY customers

These are different products, and this ADR decides only the first.

| | M2 proof of concept (decided here) | M3 nontechnical DIY setup (open) |
| --- | --- | --- |
| Who runs it | The owner, or a technical tester, on disposable test accounts | A small-business owner who has never used a terminal |
| Path | B1: `wrangler` CLI plus the local setup script (Node ≥ 22.12) | Browser only. Candidates: C (once its behaviour is verified), A2 for GitHub (ADR-002), or D after a Domain scope review |
| What it proves | The ownership model, the security controls and Launch & Own-offline operation | Completion rate and drop-off, without weakening the M2 controls |
| Access | Manual dashboard step with exact values | Still manual unless Domain confirms a scope that covers Access. The guided UI shows each click and checks the result. |
| Success bar | Every M2 test passes | To be set from M1.5/M2 evidence |

**The M2 CLI path must never be presented to DIY customers as the product setup.** Marketing and the release matrix describe the customer-owned assistant as *planned* until a guided path passes its own acceptance. A guided path may change *who clicks*. It may not change *who holds credentials*: Launch & Own still never holds a durable credential for the customer's assistant.

## Consequences
- The setup guide and consent screen (provisioning plan) are customer-facing documents, not Launch & Own actions.
- No change to `onboarding/wrangler.jsonc`, OAuth registrations or Domain secrets.
- Support must say plainly that 360Web can help over a screen share as a paid service without ever holding the customer's Cloudflare token.
