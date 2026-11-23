# Forms cost and privacy approval — #89

Workstream C code contract for contact-form cost, privacy, retention, abuse limits, and server-side Turnstile Siteverify. Static Pages hosting stays usable without any of this.

## Landed code

| Piece | Role |
| --- | --- |
| `pipeline/forms-cost-privacy-approval.mjs` | Digest-bound review + stored-row → `stored-cost-privacy-approval` gate |
| `pipeline/optional-service-budget.mjs` | Account-wide Free/Paid forecast (never a forms gate by itself) |
| `pipeline/turnstile-siteverify.mjs` | Official Siteverify POST; no secret/token logging |
| `pipeline/forms-abuse-limits.mjs` | Body size, daily quota, retention cutoff helpers |
| `onboarding/migrations/0008_forms_cost_privacy_approvals.sql` | Operator-approved gate ledger (no public insert) |
| `onboarding/forms-cost-privacy-store.mjs` | Session-fenced D1 reader for `verifyFormsCostPrivacyGate` |
| `onboarding/execute-option.mjs` | Forms path stays OFF unless `OPTION_FORMS_ENABLED=true` **and** a live approved gate row exists |
| `pipeline/customer-form-worker.mjs` | Customer D1 schema + Siteverify handler + acceptance probe ([docs](CUSTOMER_FORM_WORKER.md)) |

`canActivate` / `canWrite` / `createResources` stay false on reviews. A current cost/privacy grant plus a separate operator execution grant can authorize the three staging operations described in the forms Worker guide. Worker deployment and exact owner acceptance require separate reviews. [Staging and recovery](CUSTOMER_FORM_WORKER.md)

## Gate shape

An approved `0008` row must bind:

- exact `#88` forms consent digest (`0005` `kind=forms`, status `stored`)
- same job, GitHub user, Cloudflare account, and Pages project
- cost + privacy owner acks
- personal data, time-bound deletion
- retention 1–365 days, submissions/day 1–1000, body 256–65536 bytes

Budget `planDigest` values from `prepareOptionalExtensionReview` are **not** this gate.

## Hosted rollout (Domain #2)

1. Apply `0010` after confirming the ledger through `0009` and the dedicated onboarding D1 identity. The migration retains historical grants when an owner replaces consent.
2. Leave `OPTION_FORMS_ENABLED` unset outside a Domain-approved pilot with an exact owner grant.
3. Record cost/privacy grants through the operator workflow for the current consent.
4. Review the staged Turnstile widget and dedicated D1 before separately approving Worker deployment and the owner's exact test.
5. Independent #21 customer test remains separate.

Sol coordinates under [#83](https://github.com/mitchelldawkinsjr/launch-and-own/issues/83). Parent: [#89](https://github.com/mitchelldawkinsjr/launch-and-own/issues/89).
