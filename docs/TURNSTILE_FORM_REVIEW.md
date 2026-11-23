# Turnstile / contact-form review (Issue #88)

**Source of truth:** [`pipeline/plan-customer.mjs`](../pipeline/plan-customer.mjs).

The earlier parallel Turnstile planner was folded into the existing forms opt-in path. [`pipeline/turnstile-form-review.mjs`](../pipeline/turnstile-form-review.mjs) is only a thin adapter + toolkit `contact_forms` projector.

## Behavior

When `planCustomer({ forms: true, ownerEmail, ... })` runs:

1. Keeps the existing provisioning step DAG: D1 → Turnstile → Worker → Access → form deploy → human acceptance (so website-only verifiers can still reject early).
2. Marks Turnstile with `gate: server-side-siteverify-required` and D1/Worker with `gate: issue-89-cost-privacy-review`.
3. Without `formsConsent: true`, `formsReview` stays blocked (`owner_form_consent_required`).
4. With consent, attaches digest-bound `formsReview` (mandatory Siteverify, Free limits, `workingForm:false`, never-activate).
5. Extends safeguards so a client widget alone is never a working form.

`mode` remains `plan-only`. No Cloudflare resources, secrets, DNS, or Worker routes are created here.

## Free plan snapshot (reviewed 2026-11-22)

| Item | Free allowance |
| --- | --- |
| Widgets | Up to 20 per account |
| Hostnames | Up to 10 per widget |
| Challenges | Unlimited |
| Token lifetime | 300 seconds; single-use |
| Siteverify | `POST https://challenges.cloudflare.com/turnstile/v0/siteverify` |

## Release gates

- Domain [#2](https://github.com/mitchelldawkinsjr/launch-and-own/issues/2) owns hosted wiring.
- [#89](https://github.com/mitchelldawkinsjr/launch-and-own/issues/89) owns D1/Workers cost/privacy before create.
- Independent acceptance remains [#21](https://github.com/mitchelldawkinsjr/launch-and-own/issues/21).
