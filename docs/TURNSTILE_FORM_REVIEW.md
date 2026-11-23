# Turnstile contact-form review contract (Issue #88)

Review-only planner for optional **customer-owned** Turnstile-protected contact forms. Code: [`pipeline/turnstile-form-review.mjs`](../pipeline/turnstile-form-review.mjs).

A client Turnstile widget **alone is not a working form**. Server-side [Siteverify](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/) is mandatory. This module never creates widgets, mints secrets, opens Worker routes, changes DNS, or stores contact PII.

Parent: [#83](https://github.com/mitchelldawkinsjr/launch-and-own/issues/83). SEO already landed separately. Domain/email/custom-domain remain Domain [#2](https://github.com/mitchelldawkinsjr/launch-and-own/issues/2).

## Free plan snapshot (reviewed 2026-11-22)

| Item | Free allowance |
| --- | --- |
| Widgets | Up to 20 per account |
| Hostnames | Up to 10 authorized hostnames per widget (FQDN; no wildcards/schemes/ports/paths) |
| Challenges | Unlimited |
| Token lifetime | 300 seconds; single-use (network-convergent) |
| Siteverify | `POST https://challenges.cloudflare.com/turnstile/v0/siteverify` with widget secret + response token |

Sources: [Plans](https://developers.cloudflare.com/turnstile/plans/) · [Siteverify](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/) · [Hostname management](https://developers.cloudflare.com/turnstile/additional-configuration/hostname-management/).

## Review plan requirements

1. Server-held owner/site identity (immutable GitHub + Cloudflare IDs).
2. Explicit owner consent.
3. Authorized hostname (no localhost / internal / URL schemes).
4. Delivery target: `owner-email-forward` or `customer-owned-webhook` in this slice. `customer-owned-d1` is blocked pending separate #89 cost/privacy review.
5. Retention days + deletion plan (`owner-delete` or `time-bound`).
6. Exact Turnstile `action` string and hourly rate limit.
7. Digest-bound plan with `canActivate:false`, `canWrite:false`, `workingForm:false`.

## Security rules

- Reject missing/invalid/expired/replayed tokens via Siteverify error codes.
- Match hostname and action independently of the widget HTML.
- Never commit or chat Turnstile secrets.
- Onboarding D1 is not customer form storage.
- Quota exhaustion or provider denial must fail closed without claiming success.

## Release gates

- Code landing ≠ hosted form endpoint.
- Domain schedules any Worker/Pages Function wiring.
- Independent acceptance remains [#21](https://github.com/mitchelldawkinsjr/launch-and-own/issues/21).
- Do not market “working contact forms” from a widget-only install.
