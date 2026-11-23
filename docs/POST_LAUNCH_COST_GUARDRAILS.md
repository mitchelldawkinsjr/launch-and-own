# Post-launch cost guardrails (Issue #89)

Read-only allowance and extension-review helpers for optional **customer-owned** Workers / Pages Functions, D1, KV, and R2. A basic static Pages site must stay usable without these services. This document describes the code contract in [`pipeline/extension-cost-guardrails.mjs`](../pipeline/extension-cost-guardrails.mjs). It does **not** authorize resource creation, R2 billing activation, OAuth scope changes, DNS edits, or hosted rollout.

Parent orchestration: [#83](https://github.com/mitchelldawkinsjr/launch-and-own/issues/83). Capability vocabulary: [#84](https://github.com/mitchelldawkinsjr/launch-and-own/issues/84) / [`POST_LAUNCH_TOOLKIT_AUDIT.md`](POST_LAUNCH_TOOLKIT_AUDIT.md).

## What this slice does

| Deliverable | Behavior |
| --- | --- |
| Extension catalog | Lists `pages_functions`, `d1`, `kv`, `r2` with Free allowance snapshots and platform-vs-customer resource distinctions. |
| Eligibility projection | Maps server-held owner identity + short-lived plan evidence + explicit consent into #84 states. Never invents live remaining quota. |
| Review-only plan | Digest-bound approval payload for exact selected extensions, expected monthly usage summary, retention/deletion/rollback text. `createResources` is always `false`. |
| Budget pause projection | Marks an extension paused on quota/provider denial while `staticSiteRemainsAvailable` stays `true`. |
| Manual dashboard fallback | Returns Workers overview and R2 overview deep links for the verified Cloudflare account when live quota APIs are unavailable. |

## Free allowances (reviewed 2026-11-22)

Cite current provider docs before marketing numbers. Declared plan limits do **not** prove remaining allowance for a given account.

| Service | Free allowance snapshot | Charge / activation boundary |
| --- | --- | --- |
| Workers / Pages Functions | 100,000 requests/day; **10 ms CPU** per HTTP or Cron invocation | Workers Paid starts at $5 USD/month with higher included usage. Static asset requests on Pages stay free. [Limits](https://developers.cloudflare.com/workers/platform/limits/) · [Pricing](https://developers.cloudflare.com/workers/platform/pricing/) |
| D1 | 5M rows read/day, 100K rows written/day, 5 GB storage, 10 databases | Paid removes Free daily caps with metered overages. [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) |
| KV | 100K reads/day; 1K writes/deletes/lists/day; 1 GB stored | Dashboard/CLI ops count. [KV pricing](https://developers.cloudflare.com/kv/platform/pricing/) |
| R2 Standard | 10 GB-month, 1M Class A, 10M Class B ops/month; egress free | Requires **explicit subscription activation**. Infrequent Access has separate fees. [R2 free tier](https://developers.cloudflare.com/r2/pricing/#free-tier) · [Get started](https://developers.cloudflare.com/r2/get-started/) |

**Measured product evidence:** a 5.19 MiB ZIP upload used **95 ms** Worker CPU against the Free **10 ms** per-invocation limit ([#45](https://github.com/mitchelldawkinsjr/launch-and-own/issues/45#issuecomment-7087096052)). Do not promise Free CPU headroom for near-limit uploads.

## Platform resources are not customer extensions

- **Onboarding D1** stores Launch & Own sessions/jobs. It is not customer form/PII storage.
- **Platform ZIP staging R2** is authorization-scoped Launch & Own artifact storage (#45). It must never be confused with a customer optional media/uploads bucket.

## Security and approval rules

1. Owner / site identity must be server-derived (immutable GitHub user + repo IDs, Cloudflare account + Pages project IDs). Browser or model text is not ownership proof.
2. Plan evidence expires within 24 hours and must match the same Cloudflare account ID.
3. `consent !== true` keeps extensions at `available_opt_in` — no silent opt-in.
4. R2 without `r2Activated: true` is `blocked_permission_or_plan` until the owner activates billing/subscription in Cloudflare.
5. Review plans bind SHA-256 digests over a canonical JSON body. Retry/duplication must reuse the exact approved digest and fail closed on drift.
6. Future writers (not in this PR) must re-check identity, grants, plan evidence, and digest before any create/PATCH. This module performs **zero** Cloudflare mutations.
7. On budget exhaustion or provider denial, pause the extension only. Keep verified static Pages hosting available.

## Release gates

- Code landing is separate from hosted toolkit wiring (`onboarding/worker.mjs` / #87 UI).
- Domain (#2) schedules any Worker integration window.
- Independent customer acceptance remains [#21](https://github.com/mitchelldawkinsjr/launch-and-own/issues/21).
- Do not update the distribution release matrix to claim advanced storage/functions until owner-approved live evidence exists.
- Sol 6.2 Max (#83) owns orchestration review of state vocabulary and sequencing vs #88 forms/domain work.

## Manual operator fallback

When OAuth scopes cannot read live Workers/R2 usage:

1. Open the account Workers overview returned as `usageDashboardUrl`.
2. For R2, open `r2ActivationUrl` and confirm subscription state before reviewing any storage plan.
3. Record privacy-safe evidence (plan name, activation yes/no, date). Never commit tokens, account secrets, or customer object keys.
