# M3 guided-path spike (after M2 evidence)

Design spike only. Do not market M2 CLI as the nontechnical DIY product. Build the browser DIY path only after M2 pilot evidence and Domain review where noted.

## 1. Cloudflare Deploy Button + SHA pin check

**Goal.** Let an owner click Deploy to open a bootstrap Worker from a pinned template, then verify the deployed code matches a known tag/SHA (ADR-001 C).

**Spike checks**

- Deploy Button URL pins a specific GitHub tag or commit, not `main`.
- Post-deploy: Worker `/status` (or a public `/healthz` plus authenticated status) reports `UPSTREAM_SHA` / `VERSION`; compare to the pin.
- Document what Deploy Button still does **not** cover: Cloudflare Access policy, GitHub App create/install, KEK generation UX, website-repo scoping.

**Exit.** Written findings + whether Deploy Button is worth the M3 path or only a partial bootstrap.

## 2. Guided Access UX

**Goal.** Click-by-click Cloudflare dashboard guide plus automated verify of JWT / `/status` after the owner pastes team domain + AUD.

**In scope**

- Exact screenshots/steps for Zero Trust → Access application → email-only policy ≤ 24h.
- Script or Worker self-check that fail-closed 503 lifts only after valid owner JWT.
- Resume hooks already in `assistant/setup/provision.mjs` step 4.

**Out of scope unless Domain confirms a scope**

- Automating Access application creation via Cloudflare API (would expand CF scopes).

## 3. Evaluate A2 (Worker `/setup` GitHub App exchange)

Only after M2 Access/KEK tests pass.

- Compare local `manifest-exchange.mjs` (ADR-002 A3) vs a Worker-hosted `/setup` exchange.
- Confirm: no durable Launch & Own credential; `client_secret` never stored; one-hour code expiry; key only as Worker secret.
- Domain review required before any one-time installer OAuth (option D) or broader CF scopes.

## 4. Acceptance bar

Set from M2 drop-off evidence (where owners stalled: Access, App install, wrangler, consent). Then update `distribution/release-matrix.json` and marketing from *planned* only after guided acceptance — never from owner-only live evidence alone.

## Status

| Item | Status |
| --- | --- |
| Spike doc | This file |
| Deploy Button prototype | Not started (blocked on M2 live evidence) |
| Guided Access UI in product | Not started |
| A2 Worker exchange | Evaluate only after M2 ACC/KEK pass |
| Domain review for OAuth / CF scope expansion | Required before build |
