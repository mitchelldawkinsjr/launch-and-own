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

Every write goes through `assertOperatorApprovedExecution`. Its forms branch (`onboarding/option-execution-store.mjs`) reads the **provisioning receipt** (migration `0010`) fresh on each call and accepts only the next step's exact request (`isApprovedFormsMutation` in `pipeline/forms-provider-plan.mjs`). A step that is already recorded, out of order, or aimed at a different database is refused.

| Step | Request | Allowed only when | Bound to |
| --- | --- | --- | --- |
| Turnstile widget | `POST /accounts/{a}/challenges/widgets` | no widget recorded | name `launch-and-own-form-<project>`, domains exactly `[<project>.pages.dev]`, mode `managed` |
| Customer D1 | `POST /accounts/{a}/d1/database` | widget recorded, no D1 | name `<project>-forms` |
| D1 schema | `POST …/d1/database/{id}/query` | D1 recorded, schema not applied | `{id}` = **recorded** customer D1, never a platform D1 (`PLATFORM_D1_IDS`); `sql` byte-equal to `customer-form-d1-schema.sql` (`IF NOT EXISTS`, so a retry is safe) |
| Form Worker | `PUT /accounts/{a}/workers/scripts/<project>-form` | schema applied, no Worker recorded; and `GET …/settings` returned 404 | module SHA-256 of `CUSTOMER_FORM_WORKER_SOURCE`; `DB` binding = recorded D1; the **live #89 gate's** approval id, retention, daily cap and body cap; secret shown as `[redacted]` |
| Retention cron | `PUT …/schedules` | Worker recorded, not yet published | `17 3 * * *` |
| Public endpoint | `POST …/subdomain` | Worker recorded, not yet published | `workers.dev` on, previews off |

**Provisioning vs acceptance (two phases).**
1. `consumeStoredToolkitApproval` provisions. After each successful step it records the provider ID (sitekey, D1 id, schema flag, Worker etag, endpoint) before moving on. If a run fails, the execution goes to `needs_reconciliation`, and a new operator grant for the same approval **resumes from the receipt**: it re-reads the Turnstile secret from Cloudflare (Launch & Own never stores it) and creates nothing twice. A receipt from a different cost/privacy gate is refused (`forms_gate_changed_reconcile`). The result is `form_provisioned_awaiting_acceptance`, `workingForm: false`.
2. `verifyProvisionedFormAcceptance` runs later, owner-authorized. It reads the deployed Worker's bindings (`GET …/settings`: D1 id, hostname and gate id must match the receipt) and runs one read query on the customer D1 (`isApprovedFormsAcceptanceRead`: exactly `ACCEPTANCE_SQL` for this gate and hostname). A row exists only after a real Siteverify pass, so this is the owner's own test submission. Only then does it record `accepted_at` and report `form_verified`.

**Deployed Worker limits.** It reads at most `MAX_BODY_BYTES + 4096` actual bytes, whatever `content-length` says. It refuses reused tokens before calling Siteverify. After Siteverify passes, one D1 batch writes the submission only while under the daily cap and records the token only with it, so concurrent requests cannot exceed the cap and rejected requests leave no replay state. `/health` returns `{ok: true}` only.

- **Name collisions** stop with `*_exists_reconcile` rather than adopting or replacing unknown resources. A same-name Worker is never overwritten.

**Still not enabled:** hosted `0008`/`0010`, `OPTION_FORMS_ENABLED`, Cloudflare OAuth scopes for Turnstile, D1 and Workers Scripts write, an owner route for the acceptance check, site HTML wiring of the form and its `workers.dev` endpoint, delivery to the owner mailbox, and #21 acceptance.
