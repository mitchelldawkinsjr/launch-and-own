# Post-launch website toolkit (#87)

Owner-scoped, **read-only first** view of sites already in Launch & Own launch history.

## What shipped in this slice

| Surface | Path | Behavior |
| --- | --- | --- |
| Toolkit dashboard | `GET /toolkit` | Live URL (when verified), GitHub repo link, production SHA, approved content fingerprint, honest pending/failed/reauth labels, edit link when `can_edit` |
| Update status copy | `/site-update-status` | Approve → **Open update to publish** → Checking → Live; closed PRs retire Merge |
| Capability labels | Toolkit cards | Same #84 state vocabulary; history projection until #39 provider reads; verified/expiry times on cards |

## Explicit non-claims

- Does **not** enable Cloudflare Web Analytics, Pages PR previews, DNS, email, or paid plans.
- Does **not** call providers on `GET /toolkit` (history-first; `summarizeOwnedToolkitSite` is for owned-site + fresh reads).
- Does **not** replace long-term inventory after 30-day TTL (#39).
- Does **not** auto-merge GitHub PRs; customers still click Merge once; closed PRs do not show Merge.
- Matrix / hosted_beta promotion still needs owner-live update walkthrough (#21).

## Modules

- `onboarding/post-launch-toolkit.mjs` — history projections + HTML helpers
- `pipeline/toolkit-capabilities.mjs` — shared capability states + provider-truth projection (#84)
- Thin route wiring in `onboarding/worker.mjs` (`/toolkit` only)
