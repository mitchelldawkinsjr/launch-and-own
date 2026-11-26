# WS5 security checks for M1 (WS1–WS3)

2026-11-25 · Claude Opus 5.5 (Worker B, #167). These are **recommended acceptance tests** for Agent 1's M1 implementation (#166) against the [approved contract](../../contracts/IMPORTED_SITE_CONTRACTS.md). They use fixtures and mocks only: no accounts, no inference, no network. They don't change the contract. Where the contract already states a rule, these add the **adversarial** inputs that should prove it holds.

Threat numbers refer to the [threat model](threat-model.md).

## Validation bypasses (contract §2.1)

| ID | Input | Expected | Threat |
| --- | --- | --- | --- |
| S-01 | `text` edit whose `find` spans `</p><script>` or crosses an element boundary | `context_not_allowed` | 8 |
| S-02 | `text` replacement containing `<script>`, `&lt;script&gt;`, `&#60;img onerror=…&#62;` | Stored escaped. The output parses with **no new element or attribute nodes** (compare parsed trees, not strings). | 8 |
| S-03 | `find` text that also appears in an attribute value, a comment or `<template>` | Counted per contract. If the only match is outside a text node, `context_not_allowed`. | 8 |
| S-04 | `link` replacements: `JaVaScRiPt:alert(1)`, `java\tscript:`, `&#106;avascript:`, ` javascript:` (leading space), `data:text/html,…`, `vbscript:`, `//evil.example` | All rejected. Validate the **decoded, trimmed** value with a URL parser, then check the scheme against the allowlist. | 8 |
| S-05 | `link` replacement relative path `../../../etc/passwd` or one with `%2e%2e` | Allowed only if it resolves inside the site root, otherwise rejected | 8 |
| S-06 | `css_color` value `red; background:url(https://x)`, `red}body{…`, `red /* */`, `expression(…)`, `var(--x)` | Rejected. The replacement must parse as exactly one color token. | 8 |
| S-07 | `css_color` on a non-custom property (`color: red`) | Rejected in M1 (owner decision) | 8 |
| S-08 | Unicode tricks: a `find` that matches only after NFC normalization, zero-width characters, a BOM, CRLF and LF variants | Matching is on exact UTF-8 bytes with no normalization. The results are deterministic and documented. | 8 |
| S-09 | Two edits whose spans touch end-to-start | `overlapping_edits` ("touch" counts, per contract) | 8 |
| S-10 | Model output with an extra field, a path outside the inventory (`.github/workflows/x.yml`, `wrangler.toml`, `_headers`), or `../` in a path | `invalid_output` or `kind_not_allowed`. Nothing is applied. | 8, 15 |
| S-11 | `hostile-content` fixture: comment text instructing edits to other files | The proposal can only contain allowlisted edits. Anything else is rejected without partial apply. | 8 |

## Digests and approval (contract §2.2, §3)

| ID | Input | Expected | Threat |
| --- | --- | --- | --- |
| S-12 | Same proposal with keys and edits in a different order | Identical `proposalDigest` (JCS, sorted edits) | 6 |
| S-13 | Valid `approvalId` and digests, but **no owner session or CSRF token** (or a wrong `Origin`) | Rejected. **`approvalId` alone never authorizes**, because it may be visible to preview content. | 4, 6 |
| S-14 | Replay of a consumed `approvalId` | `approval_consumed`, and the mock GitHub records **zero** write calls | 6 |
| S-15 | Mock `main` moves after the approval check but before the ref write | `stale_base` at the pre-write re-read, and no ref created | 6 |
| S-16 | Simulated crash after `approvalId` is consumed, before the PR exists | Re-approving with a new `approvalId` for the same idempotency key creates exactly one PR. A crash after the PR exists returns the existing PR. Never two commits, and never a stuck state with no route to a PR. | 6 |
| S-17 | Different owner (`provider` matches, `id` differs; or `id` matches, `provider` differs) | `approval_mismatch` | 6, 7 |

## Writes, errors and status

| ID | Input | Expected | Threat |
| --- | --- | --- | --- |
| S-18 | The ref writer is asked for `refs/heads/main`, `launch-and-own/edit-x/../main`, `refs/tags/*` or an over-long name | Refused before any API call. Only names matching `launch-and-own/edit-[0-9a-f]{20}` pass. | 15 |
| S-19 | Mock GitHub returns 401, 403 or 404 on token mint or the installation | `credentials_revoked` → `needs_reauthorization`, with no retry | 10 |
| S-20 | Mock deployment SHA ≠ merge SHA, or a live file hash ≠ `afterSha256` | `deploy_unverified`, never `live` | 13 |
| S-21 | Logging and the model prompt are checked with a sentinel secret in the environment | The sentinel appears in no log line, model input or error message | 5, 8 |

## Not covered here (later gates)
- Access JWT validation, Worker secrets and quota guards are M2 (see the [M2 test plan](m2-test-plan.md)).
- Hosted-route CSRF and session wiring are M1.5. S-13 tests the rule at module level only.
