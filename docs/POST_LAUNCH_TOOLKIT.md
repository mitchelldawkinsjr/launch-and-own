# Post-launch website toolkit (#87)

Owner-scoped, **read-only first** view of sites already in Launch & Own launch history.

## What shipped in this slice

| Surface | Path | Behavior |
| --- | --- | --- |
| Toolkit dashboard | `GET /toolkit` | Live URL (when verified), GitHub repo link, production SHA, approved content fingerprint, honest pending/failed/reauth labels, edit link when `can_edit` |
| Update status copy | `/site-update-status` | Non-technical ladder: Approve → **Open update to publish** (Merge) → Checking → Live |
| Capability placeholders | Toolkit cards | Analytics `manual_setup` (#85), PR previews `not_available` (#86), hosting `included_verified` when live — no invented metrics |

## Explicit non-claims

- Does **not** enable Cloudflare Web Analytics, Pages PR previews, DNS, email, or paid plans.
- Does **not** replace long-term inventory after 30-day TTL (#39).
- Does **not** auto-merge GitHub PRs; customers still click Merge once.
- Matrix / hosted_beta promotion still needs owner-live update walkthrough (#21).

## Modules

- `onboarding/post-launch-toolkit.mjs` — projections + HTML helpers
- Thin route wiring in `onboarding/worker.mjs` (`/toolkit` only)
