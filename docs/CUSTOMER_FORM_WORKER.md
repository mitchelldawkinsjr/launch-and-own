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
