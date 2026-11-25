# ADR-002: GitHub credential model for the customer-owned assistant

- **Status:** **Accepted by the owner, 2026-11-25** ([#171](https://github.com/mitchelldawkinsjr/launch-and-own/issues/171) item 2): a private GitHub App per customer, with the manifest code exchanged locally under the customer's control (A3). A2 stays an M3 candidate. Domain/OAuth and #157 review of the details are still requested.
- **Blocks:** M0 decision "GitHub credential model" in #165
- **Date:** 2026-11-24 · Claude Opus 5.5

## Context

**Today:** Launch & Own uses its shared GitHub App (`GH_APP_SLUG=launch-and-own`) through user-to-server tokens. These last 8 hours, with 6-month single-use refresh tokens (GitHub docs), and are stored encrypted in the onboarding D1. The installation is checked for the rights to create repositories (`pipeline/github-app-installation.mjs`).

**What the assistant needs:** create a branch, commit and open a PR on **one** website repo, read files and check the merge and deployment state. It doesn't need administration, workflows or webhooks.

### The manifest trap
In GitHub's App Manifest flow, whoever converts the code (`POST /app-manifests/{code}/conversions`) receives the app's `pem` private key. All three steps must finish within one hour (GitHub docs). So:
- A **central** exchange puts the customer's private key on Launch & Own, which breaks "no central credential dependency" even if we promise to discard it.
- An exchange **in the customer's Worker** needs that Worker deployed and reachable first, which is the chicken-and-egg problem.

## Options

### A. A private GitHub App per customer (manifest bootstrap)
The app is created in the customer's account. It gets Contents: write, Pull requests: write and Metadata: read; webhooks are off. It is installed with **Only select repositories** on the website repo only.

At runtime the Worker:
1. Signs a JWT (expiry ≤ 10 minutes; we use 9, with `iat` 60 s in the past).
2. Mints a 1-hour installation token with `repository_ids: [websiteRepoId]` and `permissions: {contents: write, pull_requests: write}`.
3. Uses the token for one approved operation and never stores it.

Three ways to do the bootstrap:
- **A1, central exchange.** Rejected: Launch & Own sees the private key.
- **A2, the customer's Worker exchanges.**
  1. Deploy the Worker in *bootstrap mode*: no GitHub credentials, Access required.
  2. The owner opens `/setup`. The Worker builds the manifest with `redirect_url` set to itself and a `state` bound to the owner's Access `sub` plus a single-use nonce stored in D1.
  3. GitHub redirects back. The Worker exchanges the code and stores the `pem` encrypted in D1 under a KEK. The KEK is a Worker secret set at deploy time.
  4. `/setup` then permanently disables itself.

  This solves the chicken-and-egg problem by ordering: Worker first, App second.
- **A3, a local exchange by a customer-run script.** The script serves a manifest form on `127.0.0.1`, receives the redirect, exchanges the code and pipes the `pem` straight into `wrangler secret put GH_APP_PRIVATE_KEY`. It never writes the key to disk. The key passes briefly through the customer's own machine.

- **For:**
  - Fully customer-owned, and it works with Launch & Own offline.
  - Tokens are short-lived and restricted per request.
  - The customer can revoke it independently: uninstall the app, delete the key or delete the app.
- **Against:**
  - More setup steps. The app appears in the customer's developer settings.
  - Key rotation is manual: at most 25 keys, a new key must exist before the old one can be deleted, and keys never expire.
  - Contents: write can technically push to `main` (see residual risk).

### B. The existing Launch & Own App, short-lived and scoped to each approval
After each approval, Launch & Own mints an installation token restricted to the repo and permissions and hands it to the customer's Worker, or acts itself.
- **For:** the simplest UX; it reuses the existing installation.
- **Against:**
  - **Every edit depends on Launch & Own being up**, with the private key held centrally.
  - The Launch & Own App's installation has wider rights (repository creation), so a central compromise has a larger blast radius.
  - It contradicts the epic's ownership model.

### C. A fine-grained personal access token from a customer-run setup script
The customer creates a token limited to the one repo with Contents and Pull requests write, and stores it as a Worker secret.
- **For:** the simplest setup that's still independent of Launch & Own.
- **Against:**
  - A long-lived bearer token with rotation by hand.
  - Actions are attributed to the human owner, so commits and PRs made by the assistant look the same as the owner's own.
  - The epic allows tokens like this only in disposable test environments.

## Ranking against "works with Launch & Own unavailable"

This is a trade-off, not an absolute.

| Rank | Option | Independent of Launch & Own | Credential strength | Setup cost |
| --- | --- | --- | --- | --- |
| 1 | A3 | Yes | Strong (1-hour restricted tokens; key held by the customer) | Medium (CLI) |
| 2 | A2 | Yes | Strong, but the key is stored encrypted in D1 under a KEK, which is weaker than a Worker secret | Medium (browser only, after the Worker exists) |
| 3 | C | Yes | Weak (long-lived, attributed to the owner) | Low |
| 4 | B | **No** | Strong per token, but the key is central | Lowest |
| — | A1 | No (the key is central) | — | Rejected |

## Decision (proposed)

- **M2 proof of concept: A3.** The local exchange script runs in the same customer-run session as the deploy (ADR-001 B1), so there's no chicken-and-egg problem and no central key.
- **M3 guided UX:** evaluate A2 as the browser-only path once the M2 tests for one-shot `/setup`, binding to the Access identity and KEK handling pass.
- **C** is allowed only in disposable test environments.
- **B** is rejected for routine operation. It may stay as an explicitly consented, time-limited option inside a paid 360Web support engagement, with its own approval record.

## Residual risk (document for customers)
- **Contents: write allows pushes to `main`.** The Worker only ever writes refs matching `refs/heads/launch-and-own/edit-*`, the deterministic branch from the [imported-site contracts](../../contracts/IMPORTED_SITE_CONTRACTS.md) (#176), and an M2 test checks this. **Confirmed:** GitHub Free personal accounts get neither protected branches nor repository rules on **private** repos. Protected branches are listed under Pro and Team, and rulesets show Free = "Public repositories" ([GitHub plans](https://docs.github.com/en/get-started/learning-about-github/githubs-plans) and [pricing](https://github.com/pricing), read 2026-11-25). So on a private website repo, nothing on GitHub's side stops the App writing to `main`. The application's own refusal is the only control. The consent screen says so plainly.
  - **Option for customers:** a static website repo is usually fine to make **public**, because the published site is public anyway. On a public repo, Free includes rulesets, so the owner can add a ruleset blocking direct pushes to `main` with no bypass for the App. The setup guide offers this as an optional hardening step. It's never required, and never suggested for repos holding anything private.
- **The Workflows permission is deliberately not granted.** Commits that touch `.github/workflows/*` fail at GitHub, which backs up the path allowlist.
- **The manifest code is a bearer secret.** The REST docs show the conversion returning `client_id`, `client_secret`, `webhook_secret` and `pem`. They document no authentication (no 401 response, and the example sends no `Authorization` header) ([REST: create app from manifest](https://docs.github.com/en/rest/apps/apps#create-a-github-app-from-a-manifest), read 2026-11-25). So anyone holding the code within its hour gets the key. The A3 script binds only to `127.0.0.1`, checks `state`, never logs the redirect URL, and exchanges immediately. The assistant doesn't use the user OAuth side of the App, so `client_secret` is **discarded** and never stored. `webhook_secret` is null, because webhooks are off.
- **To confirm in M2:** acceptance of the variable-length `ghs_` token format (T-BOOT-3).
