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

1. The onboarding beta database is migrated through `0010`. Domain confirmed a compatible onboarding Worker with the forms flag disabled. [Schema evidence](https://github.com/mitchelldawkinsjr/launch-and-own/issues/2#issuecomment-7114063388) · [Deployment evidence](https://github.com/mitchelldawkinsjr/launch-and-own/issues/2#issuecomment-7117559538)
2. For a pilot after #21, identify one consenting owner and an exact live managed `pages.dev` project. Domain verifies current account entitlements and the approved credential path for Turnstile and customer D1. The configured onboarding OAuth request currently lacks those write scopes. [Onboarding scopes](../onboarding/wrangler.jsonc) · [Independent acceptance](https://github.com/mitchelldawkinsjr/launch-and-own/issues/21)
3. Review the cost and privacy limits for that site, then record the current forms consent, cost/privacy grant, and separate operator execution grant. Domain approves the bounded `OPTION_FORMS_ENABLED=true` staging window. The exact operations create the widget, create dedicated customer D1, and apply the reviewed schema.
4. The staging receipt links to a separate Worker publication review. Review the source digest, verified database binding, secret binding, submission limits, retention cron, and site change before any publication. The current product stops at this review.
5. Acceptance requires the owner’s exact Siteverify-passed test against the approved deployed Worker version and database. Record only the redacted test receipt. Treat health checks as liveness. [Worker review and acceptance](CUSTOMER_FORM_WORKER.md)

Sol coordinates under [#83](https://github.com/mitchelldawkinsjr/launch-and-own/issues/83). Parent: [#89](https://github.com/mitchelldawkinsjr/launch-and-own/issues/89).
