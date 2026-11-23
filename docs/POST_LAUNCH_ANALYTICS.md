# Post-launch Web Analytics: read-only foundation (#85)

**Status (2026-11-22): implemented in code on an unmerged feature branch; not deployed or customer-accepted.** This slice is *not* Analytics enablement, a visit counter, customer-facing UI, or a claim that a site is collecting data. It exists to give the #87 dashboard a conservative server-side adapter after #39 owner inventory is complete.

## Cloudflare evidence and limitations

- [Cloudflare Pages: Enable Web Analytics](https://developers.cloudflare.com/pages/how-to/web-analytics/) documents **Workers & Pages > select project > Metrics > Enable**. Enabling this may add a client-side JavaScript performance/traffic beacon **on the next deployment**. Do not silently consent, trigger builds, or change existing static site files.
- [Cloudflare Pages project GET API](https://developers.cloudflare.com/api/resources/pages/subresources/projects/methods/get/) supports `GET /accounts/{account_id}/pages/projects/{project_name}` with Pages Metadata Read / Pages Read / Pages Write permissions. The project model can include `web_analytics_tag` and `web_analytics_token`. The adapter only reads whether a tag was reported, **never** returns the tag, token, arbitrary provider JSON, environment variables, or user data.
- [Web Analytics limits](https://developers.cloudflare.com/web-analytics/limits/) lists **10 tracked sites not proxied via Cloudflare** versus no limit for proxied sites, and plan-dependent rules (Free: 0 custom rules). Do not assume these quota rules apply identically to every Pages site/account configuration. #84 owns per-customer plan/scopes/entitlement truth.
- Metrics dashboards and API querying are **not implemented** here. A project tag does **not** prove the beacon is present in the deployed HTML, that data has arrived, that Core Web Vitals are available, or that visitor counts are zero. Respect privacy disclosures and relevant consent requirements before enabling real-user monitoring.

## Adapter contract

`pipeline/pages-analytics.mjs` exports `readPagesAnalyticsStatus({site, principal, cloudflareAccessToken, fetchFn?})`.

Both `site` and `principal` **must be supplied by the trusted backend**, never from a browser query, form, agent message, or client-controlled JSON. `site` is the immutable current managed-site inventory from #39 (verified GitHub user ID, repo ID, account ID, Pages project ID, project name, GitHub owner/repo, `main`); `principal` is the authenticated and freshly authorized session's GitHub user ID and selected Cloudflare account ID. The caller must recheck revocation and authorization epoch, use refreshed OAuth access tokens server-side, and ensure this is still the same currently managed repository. **The adapter does not revalidate GitHub's live user identity by itself.**

After the identity gate, the only network request is `GET` to the account-specific Pages project. The exact Pages project ID, `pages.dev` subdomain, GitHub repo name/ID/owner, production branch, source type and static output rules must match the trusted site record (using `matchesApprovedPagesProject`). Any mismatch fails closed without returning dashboard links.

The returned feature projection contains `feature`, `state`, `reason`, `configuration`, `metrics`, `action`, `projectDashboardUrl` and `analyticsDashboardUrl` only. It never exports secrets, raw provider response fields, a customer site URL, or user metrics. UI consumers should show **manual setup** and open the verified project in the owner's Cloudflare dashboard only after a successful project match. The Cloudflare dashboard may still require the user to sign in and select the correct account.

| State / configuration | UI meaning |
| --- | --- |
| `manual_setup` + `not_observed` | Verified project is readable; enablement *not established*. Open its Cloudflare Metrics UI to inspect or opt in manually. |
| `manual_setup` + `tag_reported_activation_unverified` | Project GET reports a Web Analytics tag; activation, beacon injection, live data and visits are **not independently verified**. |
| `blocked_permission_or_plan` | No access token, revoked grant, or forbidden Pages project GET. Ask user to reconnect or check provider permissions. No cross-account deep link. |
| `not_available` | Managed Pages project returned HTTP 404; **not** a claim that Web Analytics as a product is unavailable. No cross-account deep link. |
| Transport/error exception | Rate limiting, provider outage, redirect, malformed response, or project ownership mismatch. Caller must show an **unknown/temporarily unavailable** state, not a fake healthy/zero-metrics state. |

All six metric fields, including visitors, pageviews and Core Web Vitals, remain `null` and `metrics.status='not_queried'`. No `active_verified` is possible from this phase. No quotas/plan entitlements are invented.

## Integration, activation and rollout gates

1. #84 and Sol 6.2 Max approve status naming, accepted Pages OAuth scopes, current free-plan constraints and public copy. Keep the adapter standalone; do not bypass #39's authenticated, durable site inventory.
2. #39 supplies trusted current inventory and #87 integrates a CSRF/session-protected, cache-disabled **read-only** UI. Domain #2 coordinates any edit to `onboarding/worker.mjs`, especially around open drafts #31/#53. Never pass a token through browser HTML.
3. For future enablement, separately present the exact account/project, disclosure about the injected analytics beacon/privacy notice, current settings and expected deployment behavior; capture explicit human approval. Verify provider authorization before and after any PATCH/write, including idempotence, token revocation, site replacement and rollback. None is implemented in this PR.
4. Before displaying real analytics, independently verify enablement/beacon on the canonical production site, metrics access and actual provider responses. Distinguish no data yet from measured zero traffic and measured values. Confirm the real independent customer via #21. Do not update release-matrix/website pricing claims merely because this read-only code merged.

## Regression evidence

`npm test` discovers `pipeline/pages-analytics.test.mjs` automatically. The isolated suite asserts tenant/account and project-ID mismatch, malformed IDs/path injection, GET-only transport, 401/403/404/429/5xx, throttled 403, unexpected redirects, bogus provider responses, token non-disclosure, unknown metrics, missing provider tag, and tag-not-equal-active. Run `npm test`, `npm run qa:distribution`, `npm run preflight:onboarding` and normal PR/recovery CI before considering merge. **No real Cloudflare API mutation or provider acceptance test is included.**
