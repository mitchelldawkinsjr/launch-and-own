# Launch & Own Personal: WS4 + WS5 design

**Status: design only.** Nothing here is implemented, provisioned or available. The M1.5 gate in [#165](https://github.com/mitchelldawkinsjr/launch-and-own/issues/165) must pass before any of it is built. The [release matrix](../../../distribution/release-matrix.json) stays authoritative for availability.

Author: Claude Code · Claude Opus 5.5 (`claude-opus-5-5`), 2026-11-24. Reviewers requested: #157 (security) and Domain/OAuth.

| Document | What it covers |
| --- | --- |
| [ADR-001 Cloudflare scopes](adr-001-cloudflare-scopes.md) | Expand Launch & Own OAuth scopes, or have the customer deploy |
| [ADR-002 GitHub credential model](adr-002-github-credential-model.md) | Per-customer App, shared Launch & Own App, or a fine-grained token |
| [ADR-003 Assistant code location](adr-003-assistant-code-location.md) | Separate private repo vs a directory in the website repo |
| [ADR-004 Update channel](adr-004-update-channel.md) | Owner-approved update PRs, version pinning, security fixes, deprecation |
| [ADR-005 Editing surfaces and signal](adr-005-editing-surfaces-and-signal.md) | Hosted toolkit vs assistant editing, editor parity, no default telemetry (accepted 2026-11-27) |
| [Threat model](threat-model.md) | Bootstrap, Access, token lifetimes, replay and isolation, prompt injection, quota, revocation, uninstall |
| [Provisioning plan](provisioning-plan.md) | Resource manifest, consent and cost screen, resume and rollback, free-tier limits with sources |
| [M1 security checks](m1-security-checks.md) | 21 adversarial unit-level checks for the WS1–3 implementation, using fixtures and mocks only |
| [M2 test plan](m2-test-plan.md) | Denied access, changed base SHA, revoked credentials, quota, failed deploy, retries, cleanup, Launch & Own offline |
| [M2 pilot runbook](m2-pilot-runbook.md) | Disposable-account preconditions, dry-run, live sequence after owner authorization |
| [M3 guided-path spike](m3-guided-path-spike.md) | Deploy Button + SHA pin, guided Access, A2 evaluation; Domain gates |

## Recommendations in one table

| Decision | Recommendation (owner status) | Main reason |
| --- | --- | --- |
| Cloudflare scopes | ✅ *Accepted 2026-11-25.* **Customer-run deploy.** Launch & Own `CF_SCOPES` stay unchanged. | No central credential that can write code into customer accounts. Wrangler's OAuth has no Access scope, so Access is a manual step either way. |
| GitHub credentials | ✅ *Accepted 2026-11-25.* **Per-customer private GitHub App.** The manifest code is exchanged on the customer's machine. | Works with Launch & Own offline. One-hour tokens restricted per request. The private key never reaches Launch & Own. |
| Assistant location | ✅ *Accepted 2026-11-25.* **Separate private repo** generated from a versioned upstream template | Can't leak into Pages output, and the assistant can't edit its own code |
| Update channel | ✅ *Accepted 2026-11-25 (option A2).* **A weekly workflow in the customer's assistant repo opens a pinned, provenance-checked PR only for security, breaking-change and end-of-support releases.** Bug fixes and features get a dashboard notice. | Owners review only the updates that can't wait. The release class comes from an attested asset, never editable notes. |

## Conflicts with AGENTS.md that need an owner decision

1. *"Never implement a second publishing stack."* That line is about agent clients, but a customer-hosted assistant that opens PRs is a second runtime for publishing. **Proposal:** treat it as compliant only if it runs the same WS2/WS3 library relocated (the M1.5 "runtime-agnostic module" requirement), never a fork. Please amend AGENTS.md to say so.
2. *"Domain/OAuth owns provider permissions, secrets and production deployments."* Customer-run assistant deployments are the customer's production, not Launch & Own's. **Proposal:** Domain owns Launch & Own's central permissions and signs off each upstream assistant template release. Customers own their deployments.
3. *"Never grant agents unilateral resource-creation authority."* The model inside the assistant never provisions anything. Creating a branch or PR happens only after an approval bound to the exact revision. Provisioning is customer-run. This is compliant as designed; I'm listing it so reviewers can check it.

## Facts verified for this design

All dates are when the page was read (2026-11-24), with the page's own `dateModified` where it shows one.

| Fact | Source |
| --- | --- |
| Workers Free: 100,000 requests/day (Error 1027 above that), 10 ms CPU, 50 subrequests, 100 Workers, 5 cron triggers | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) (modified 2026-11-19) |
| D1 Free: 10 databases, 500 MB each, 5 GB per account, 5M rows read/day, 100k rows written/day, 50 queries per invocation | [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) (2026-11-20), [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) (2026-11-18) |
| Workers AI: 10,000 Neurons/day free. On Free, usage above that fails with an error (no bill). On Paid, it's $0.011 per 1,000 Neurons. Some models need paid billing. | [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) (2026-11-18) |
| Pages Free: 500 builds/month, 1 concurrent, 20,000 files, 25 MiB per file, 100 projects | [Pages limits](https://developers.cloudflare.com/pages/platform/limits/) (2026-11-19) |
| Access JWT: `Cf-Access-Jwt-Assertion` header; check `iss`, `aud`, `exp` and `nbf` against team certs. Keys rotate every 6 weeks and old keys stay valid for 7 days. | [Validate JWTs](https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/) (2026-11-17) |
| Access can protect `workers.dev` and preview URLs | [workers.dev routing](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/) (2026-11-06) |
| Zero Trust Free: 500 Access applications, 50 service tokens | [Zero Trust account limits](https://developers.cloudflare.com/cloudflare-one/account-limits/) (2026-11-17) |
| Secrets are hidden after being set. `wrangler secret put` deploys a new version. | [Secrets](https://developers.cloudflare.com/workers/configuration/secrets/) (2026-11-21) |
| Wrangler OAuth scopes include `workers_scripts:write`, `d1:write`, `ai:write`, `secrets_store:write` and `offline_access`, but **no Access/Zero Trust scope** | Scope table bundled in `wrangler@4.168.0` (`wrangler-dist/cli.js`). `wrangler login --scopes-list` prints it. |
| Manifest flow: all three steps must finish within one hour. The conversion returns `id`, `pem` and `webhook_secret`. | [App manifest](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest) |
| Installation token: lasts 1 hour, can be restricted with `repository_ids` and `permissions`. Stateless `ghs_APPID_JWT` format rolled out from 2026-04-27, so length varies. | [Installation token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app) |
| App JWT `exp` at most 10 minutes. Private keys: up to 25, never expire, delete only after adding another. | [JWT](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app), [Private keys](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps) |
| Actions in new personal repos can't open PRs by default, and `GITHUB_TOKEN` defaults to read-only `contents`. PRs opened with `GITHUB_TOKEN` start CI only after approval, and its pushes start none. Immutable releases lock the tag and assets and generate a release attestation, but notes stay editable. Free plan: $12/month of Actions compute for private repos, blocked (not billed) after that without a payment method. | [Actions settings](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository), [GITHUB_TOKEN](https://docs.github.com/en/actions/concepts/security/github_token), [Immutable releases](https://docs.github.com/en/code-security/supply-chain-security/understanding-your-software-supply-chain/immutable-releases), [Actions billing](https://docs.github.com/en/billing/managing-billing-for-your-products/managing-billing-for-github-actions/about-billing-for-github-actions) (read 2026-11-25) |
| User tokens last 8 hours. Refresh tokens last 6 months and are single-use. | [Refreshing user tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens) |

| Manifest conversion returns `client_id`, `client_secret`, `webhook_secret` and `pem`, with no authentication documented | [REST: create app from manifest](https://docs.github.com/en/rest/apps/apps#create-a-github-app-from-a-manifest) (read 2026-11-25) |
| GitHub Free personal accounts get **no** protected branches or rulesets on **private** repos. Rulesets are available on public repos. Artifact attestations on Free: public repos. | [GitHub plans](https://docs.github.com/en/get-started/learning-about-github/githubs-plans) and [pricing](https://github.com/pricing), read 2026-11-25 |
| `gh attestation verify` has `--repo`, `--owner` (documented as an organization scope) and `--signer-workflow`. `gh release verify` and `verify-asset` check release attestations. | [gh attestation verify](https://cli.github.com/manual/gh_attestation_verify), [gh release verify-asset](https://cli.github.com/manual/gh_release_verify-asset) (read 2026-11-25) |
| `GITHUB_TOKEN` permissions have no `workflows` key. Installation tokens need the App's `workflows` permission to change workflow files. | [Workflow syntax: permissions](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#permissions), [App permissions](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps) (read 2026-11-25) |
| Workers AI text generation: 300 requests/minute on models that don't need Workers Paid | [Workers AI limits](https://developers.cloudflare.com/workers-ai/platform/limits/) (modified 2026-09-17) |
| Deploy to Cloudflare clones the repo into the user's account and provisions D1. The source repo must be public. No ref pinning is documented. | [Deploy buttons](https://developers.cloudflare.com/workers/platform/deploy-buttons/) (modified 2026-10-12) |
| Worker billing: "Only requests that hit a Worker will count against your limits". Requests blocked by Access aren't addressed. | [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) (modified 2026-11-18) |

**Not verified. Must be checked before M2 or treated as unknown:**
- The Zero Trust Free seat (user) limit
- Whether requests Access denies count toward Worker request quotas
- Whether immutable releases can be enabled on a repo owned by a free personal account
- Whether Deploy to Cloudflare can pin a tag or commit
- Whether third-party OAuth clients (as opposed to wrangler) can request the same scopes, or any scope that covers Access

Status names, failure codes, branch names and approval binding follow the [imported-site contracts](../../contracts/IMPORTED_SITE_CONTRACTS.md) (#176), **approved by the owner** on 2026-11-25 (#171 item 7, revision 2). If the contract changes, this design follows it.

### Contract follow-ups this design depends on

These were raised in the [WS5 review on #176](https://github.com/mitchelldawkinsjr/launch-and-own/pull/176#issuecomment-7153910602). All four are **resolved in the approved revision 2 ([#178](https://github.com/mitchelldawkinsjr/launch-and-own/pull/178))**. This design already uses the revision 2 names.

| # | Follow-up | In revision 2 | Threat / test |
| --- | --- | --- | --- |
| 1 | An owner identity that works with Access | `owner: {provider, id}`, compared together | 3, 6 / T-ACC-5 |
| 2 | Single-use approval | `approvalId` consumed before any write, `approval_consumed` | 6 / T-SHA-3, T-RET-2 |
| 3 | A code for revoked GitHub access | `credentials_revoked` → `needs_reauthorization` | 10 / T-REV-1..3 |
| 4 | No gap between approval and commit | Re-read `main` immediately before the ref write, and branch from `baseCommitSha` | 6 / T-SHA-1, T-SHA-4 |

One clarification [requested on #178](https://github.com/mitchelldawkinsjr/launch-and-own/pull/178#issuecomment-7154206025) isn't in the approved text: **`approvalId` isn't an authorization secret.** It may be visible to preview content, so approval must always require the owner session and CSRF token. This design treats that as a required control (M1 check S-13).
