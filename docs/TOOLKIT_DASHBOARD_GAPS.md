# Onboard dashboard ↔ pipeline alignment (#87)

Gap list from the November 2026 toolkit review. Each item maps copy, gating, or structure to what the Worker and pipeline actually do.

| # | Gap | Resolution |
| --- | --- | --- |
| 1 | Setup implied toolkit configures domain, email, and forms | Setup copy now states requests are saved in toolkit only; DNS and forms are not created there. |
| 2 | Toolkit mixed 30-day launch rows with live account discovery with no framing | Toolkit intro plus **Recent launches** section; live reads fold into launch cards (**In your accounts now**) or **Other sites in your accounts**. |
| 3 | Landing ZIP copy denied editing while hosted routes offer limited imported edit | ZIP compatibility and tests describe limited post-launch edit for compatible static sites, subject to hosted beta acceptance. |
| 4 | Signed-out nav “Owner toolkit” sounded like a live product surface | Marketing nav label clarifies sign-in is required. |
| 5 | Options link sounded like instant domain/email/form setup | Services tab links to Optional features. When `OPTION_OWNER_ACTIVATION_ENABLED` and per-kind flags are on, toolkit capabilities show **Available** (not “Not ready”) for domain, email, forms, analytics, and SEO/redirects, matching the Turn on controls on `/site-options`. PR previews stay blocked until Access review. |
| 6 | Inventory cards read like live health checks | Badge reads “Launch & Own managed site · open site toolkit for live checks”. |
| 7 | Live `summarizeOwnedToolkitSite` vs history cards disagree on ZIP updates | **Deferred (#39):** history cards use `historyToolkitCapabilities` (imported edit when live ZIP); live site-toolkit deployment view uses edit paths from inventory, not the shared projection. Unify when inventory cards adopt `summarizeOwnedToolkitSite` with an imported-edit flag. See [POST_LAUNCH_TOOLKIT_AUDIT.md](./POST_LAUNCH_TOOLKIT_AUDIT.md). |

Implementation evidence: `npm test`, onboarding browser mock (`tests/onboarding-mock.spec.mjs`). Release truth remains in [distribution/release-matrix.json](../distribution/release-matrix.json).