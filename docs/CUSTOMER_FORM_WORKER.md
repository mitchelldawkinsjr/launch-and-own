# Customer-owned form Worker and D1 — #89

Isolated implementation of the contact-form runtime Workstream C still owed after the cost/privacy gate landed: **server Siteverify**, **dedicated customer D1**, **abuse/retention**, and a **mocked end-to-end acceptance** probe.

## Files

| File | Role |
| --- | --- |
| `pipeline/customer-form-d1-schema.sql` | Customer DB schema (`contact_submissions`, single-use token table) |
| `pipeline/customer-form-worker.mjs` | Request handler, schema apply, purge, acceptance helper |

## Hard boundaries

- Never use Launch & Own onboarding D1 or ZIP staging R2.
- Turnstile secret and raw tokens are never returned or logged.
- Tokens are recorded as SHA-256 hashes before Siteverify success is trusted.
- `verifyCustomerFormAcceptance` returns the `{serverSiteverify, customerD1Bound, endToEndAccepted}` shape expected by `approved-extension-consumer`.
- This module does **not** deploy a Worker, create Cloudflare resources, or flip `OPTION_FORMS_ENABLED`.

## Hosted follow-up (Domain)

Provider adapters must create a customer Turnstile widget + dedicated D1, apply this schema, deploy a Worker that calls `handleCustomerFormSubmission`, then call `verifyCustomerFormAcceptance` (or equivalent live probe) before claiming a working form.

## Provider adapter and operator gate (code-only, #89)

`pipeline/cloudflare-extension-provider.mjs` now implements the four methods `formsWork` requires. Every write goes through `assertOperatorApprovedExecution`, whose forms branch (`onboarding/option-execution-store.mjs`) only accepts the exact requests in `isApprovedFormsMutation` (`pipeline/forms-provider-plan.mjs`):

| Step | Request | Bound to |
| --- | --- | --- |
| Turnstile widget | `POST /accounts/{a}/challenges/widgets` | name `launch-and-own-form-<project>`, domains exactly `[<project>.pages.dev]`, mode `managed` |
| Customer D1 | `POST /accounts/{a}/d1/database` | name `<project>-forms` (never onboarding) |
| D1 schema | `POST …/d1/database/{uuid}/query` | `sql` byte-equal to `customer-form-d1-schema.sql` |
| Form Worker | `PUT /accounts/{a}/workers/scripts/<project>-form` | module SHA-256 of `CUSTOMER_FORM_WORKER_SOURCE`; bindings exactly DB + hostname + the **live #89 gate's** approval id, retention, daily cap and body cap; secret shown to the approver as `[redacted]` |
| Retention cron | `PUT …/schedules` | `17 3 * * *` |
| Public endpoint | `POST …/subdomain` | `workers.dev` on, previews off |

- **Deployable Worker:** `pipeline/customer-form-worker-source.mjs` is self-contained, has no `node:fs`, and uses async D1. `customer-form-worker.mjs` stays the reference handler.
- **Acceptance is honest:** `verifyFormAcceptance` reads the Worker's `/health` (booleans only). It reports `endToEndAccepted` only once a Siteverify-passed submission exists for that gate, which means the owner's own test submission.
- **Name collisions** stop with `*_exists_reconcile` rather than adopting unknown resources.

**Still not enabled:** hosted `0008`, `OPTION_FORMS_ENABLED`, Cloudflare OAuth scopes for Turnstile, D1 and Workers Scripts write, site HTML wiring of the form and its `workers.dev` endpoint, delivery to the owner mailbox, and #21 acceptance.

**Known design gap (for Sol / #83):** the consumer requires `endToEndAccepted` in the same execution that creates the resources. Real acceptance needs a later owner submission, so it needs a two-phase `deployed → awaiting owner test submission → verified` state.
