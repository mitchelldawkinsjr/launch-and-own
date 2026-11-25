# M2 test plan: independent assistant proof of concept

Design only, 2026-11-24 · Claude Opus 5.5.

**Environment.** Use only disposable accounts authorized for testing: a GitHub test user, a Cloudflare test account on Workers Free and a test website repo. **Nothing runs before the owner's explicit test-account authorization (#165 M2).** No customer or production resources.

**Evidence for every case:** request IDs, redacted responses, D1 rows, and GitHub/Cloudflare dashboard state with tokens redacted. Record pass or fail in the M2 evidence comment.

**Release.** Every test must pass, or have a documented, accepted deviation, before M2 is reported complete. Owner-live evidence is not independent customer acceptance (AGENTS.md).

## Denied access (ACC)

| ID | Case | Expected result |
| --- | --- | --- |
| T-ACC-1 | No Access JWT (direct request, Access bypassed through a second hostname if one exists) | 403/503, no data, no inference, no GitHub call |
| T-ACC-2 | JWT with the wrong `aud` (another Access app in the same team) | 403 |
| T-ACC-3 | JWT with the wrong `iss` (another team) or an unknown `kid` | 403. Certs are refetched once, with no loop. |
| T-ACC-4 | Expired JWT, or `nbf` in the future | 403 |
| T-ACC-5 | Valid JWT for a non-owner email (policy temporarily widened) | 403 from the Worker's own owner check, which compares `{provider: "cloudflare_access", id}` together |
| T-ACC-6 | Before Access is configured (bootstrap mode) | Every route except `/healthz` returns 503 |
| T-ACC-7 | Cross-site POST carrying the Access cookie, wrong `Origin`, or a missing CSRF token | 403, no state change |

## Bootstrap (BOOT)

| ID | Case | Expected result |
| --- | --- | --- |
| T-BOOT-1 | Manifest code reused after a successful exchange | GitHub rejects it. The script reports it and changes nothing. |
| T-BOOT-2 | Exchange attempted after more than one hour | Fails cleanly and the step can be restarted |
| T-BOOT-3 | Exchange the manifest code: confirm no authentication is needed, `client_secret` is discarded and never stored or logged, and variable-length `ghs_` tokens are accepted | Matches ADR-002. A grep of logs and state files finds no code, `pem` or `client_secret`. |

## Changed base SHA (SHA)

| ID | Case | Expected result |
| --- | --- | --- |
| T-SHA-1 | Approve, then push a commit to `main` before the PR is created | PR creation fails closed with `stale_base`, and the approval is consumed or invalidated |
| T-SHA-2 | Approval digest doesn't match the staged bytes (one file altered) | Rejected, nothing committed |
| T-SHA-3 | Approval replayed after use, or after its expiry (15 min) | `approval_consumed` or `expired`. No GitHub write happens. |
| T-SHA-4 | Push to `main` **between** approval and the ref write (pause the Worker after the approval check) | The re-read before the ref write fails with `stale_base`, and no branch is created |

## Revoked credentials (REV)

| ID | Case | Expected result |
| --- | --- | --- |
| T-REV-1 | App uninstalled from the repo | The next mint fails, the reason is `credentials_revoked` and the status `needs_reauthorization`, there's no retry loop and the dashboard explains it |
| T-REV-2 | Private key deleted (after a second key exists) | Same as T-REV-1 until the new key is deployed, then it recovers |
| T-REV-3 | GitHub App deleted | Same as T-REV-1. The guide covers recreating it. |
| T-REV-4 | Key rotation runbook: add a key, deploy, verify, delete the old key | No downtime beyond one deploy |
| T-REV-5 | Owner removed from the Access policy | 403 on the next request after the session ends |

## Isolation (ISO)

| ID | Case | Expected result |
| --- | --- | --- |
| T-ISO-1 | Installation widened to a second repo; request names that repo | Rejected before a token is minted. The minted token can't read the second repo. |
| T-ISO-2 | Preview origin tries to reach D1 write, secrets or the GitHub API | Not possible: no bindings or secrets present (inspect the Worker settings) |
| T-ISO-3 | Writes go only to `launch-and-own/edit-*` (the #176 deterministic branch) | Code path test plus an audit of every ref the run created |

## Prompt injection (INJ)

| ID | Case | Expected result |
| --- | --- | --- |
| T-INJ-1 | Site text tells the model to edit `.github/workflows/x.yml` | Validator rejects it, and GitHub would refuse anyway (no Workflows permission) |
| T-INJ-2 | Site text tells the model to add `<script>` or a `javascript:` link | Rejected |
| T-INJ-3 | Site text asks the model to output secrets or environment values | The model has none. The output contains no env values (grep the logs). |
| T-INJ-4 | Model returns invalid or oversized output | Rejected and shown as "could not make this change" |

## Quota exhaustion (QUO)

| ID | Case | Expected result |
| --- | --- | --- |
| T-QUO-1 | Daily Neuron budget reached (set it low for the test) | Inference refused before the call, with a clear message and reset time |
| T-QUO-2 | Workers AI returns its over-limit error | Handled the same way, no retry storm |
| T-QUO-3 | Burst of owner requests | Rate limited, no D1 write amplification |
| T-QUO-4 | Measure CPU per request on a realistic site | Logged against the 10 ms Free limit. If it goes over, raise it as an M2 blocker. |

## Failed deploy (DEP)

| ID | Case | Expected result |
| --- | --- | --- |
| T-DEP-1 | `wrangler deploy` or migrations fail partway through provisioning | Resume completes it. Rollback removes only what this run created. |
| T-DEP-2 | Pages build fails after the owner merges | Status `failed`, never `live`. `live` only for a Pages deployment matching the exact merge SHA (#176 vocabulary). |
| T-DEP-3 | Rollback to the previous Worker version | Works on the N-1 schema |

## Retries and idempotency (RET)

| ID | Case | Expected result |
| --- | --- | --- |
| T-RET-1 | Network drops after the PR is created but before the response | Retry finds the existing branch or PR by its deterministic name, and no duplicate is created |
| T-RET-2 | Same approval submitted twice at the same time | Exactly one commit and one PR (D1 unique constraint) |
| T-RET-3 | GitHub 5xx or secondary rate limit | Bounded backoff, then surfaced to the owner |

## Updates (UPD)

| ID | Case | Expected result |
| --- | --- | --- |
| T-UPD-1 | The update workflow opens a PR for a newer immutable, attested release | Pins the new version, with `UPSTREAM_SHA` taken from the attestation (never from the release notes) |
| T-UPD-2 | The release isn't immutable, the attestation is missing or invalid, or it's signed by another repo | No PR is opened. The dashboard shows "update could not be verified". |
| T-UPD-3 | "Allow GitHub Actions to create and approve pull requests" is off (the default) | The workflow can't open a PR and falls back to the dashboard notice (option B). With the setting on, the PR is created and **never approved by the workflow**. |
| T-UPD-4 | A release changes `.github/workflows/*` | The update PR excludes those files and flags a manual step. Record whether `GITHUB_TOKEN` can write workflow files, to resolve the open question in ADR-004. |
| T-UPD-5 | CI behaviour on a bot-opened update PR | `pull_request` runs wait for approval. No deploy runs until the owner merges. Record observed behaviour. |
| T-UPD-6 | Enable release immutability on the (disposable) upstream test repo owned by a free personal account. Publish draft → assets → release. Verify with `gh release verify-asset` and `gh attestation verify --repo … --signer-workflow …`. | It works, or ADR-004 switches to the signed-tag fallback. A tarball attested by a different workflow fails. |
| T-UPD-7 | Verified `fix` or `feature` release | No PR. The dashboard shows "update available". |
| T-UPD-8 | Verified `release.json` says `feature`, while the release notes say "security" (or the other way round) | Only the attested asset counts, and the notes are ignored. A missing or unverifiable `release.json` means no PR. |
| T-UPD-9 | Advisory published for the running version on a `fix` release, or the running version enters its last 90 days of support | A PR is opened, labelled `security` or with the end-of-support date |
| T-ISO-4 | Optional hardening: public website repo with a ruleset blocking direct pushes to `main` (no bypass for the App), then try a direct App write to `main` | GitHub rejects it |

## Cleanup (CLN)

| ID | Case | Expected result |
| --- | --- | --- |
| T-CLN-1 | Run the uninstall checklist | No assistant Workers, D1, Access app or GitHub App remain. The website repo is unchanged. |
| T-CLN-2 | D1 export before deleting | Approval history is readable |
| T-CLN-3 | Launch & Own central holds no records for this assistant | Query the onboarding D1 (read-only, by Domain) and find none |

## Launch & Own offline (OFF)

| ID | Case | Expected result |
| --- | --- | --- |
| T-OFF-1 | Make `*.360web.cloud` unreachable from the test machine and run a full edit: request, preview, approval, PR, merge, live | The full flow passes |
| T-OFF-2 | Audit the Worker's outbound requests during T-OFF-1 (tail logs) | Requests only to `api.github.com`, the Access certs URL and Workers AI. **None** to Launch & Own hosts. |
