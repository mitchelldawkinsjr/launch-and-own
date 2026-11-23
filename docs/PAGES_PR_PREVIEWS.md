# Cloudflare Pages PR previews (#86)

Status: **policy code merged, not wired, not live.** No route, job or UI calls it yet. Approved launches still provision with `preview_deployment_setting: 'none'` (`pipeline/provision-site.mjs`). The read-only audit in #83 found 3 `esp-*` projects at `none`.

## Why previews are off by default

From Cloudflare's [preview deployments docs](https://developers.cloudflare.com/pages/configuration/preview-deployments/):

- Preview URLs are **public by default**.
- Every preview gets a per-deployment URL, `<hash>.<project>.pages.dev`. That URL stays up until the deployment is deleted.
- Every branch also gets an alias, `<branch>.<project>.pages.dev`, that follows its newest commit. Names are lowercased, and characters other than letters and digits become `-`. So a Launch & Own update branch `launch-and-own/site-<digest>` becomes `launch-and-own-site-<digest>.<project>.pages.dev`.
- PR previews are only built for branches in the same repository.
- Previews send `X-Robots-Tag: noindex`. That keeps them out of search engines, but they are still public.
- Restricting previews takes Cloudflare Access. In the dashboard: project → Settings → General → **Enable access policy**. This covers preview deployments only, not production or custom domains.

Launch & Own's Cloudflare OAuth client has no Access scopes, and this work doesn't request any. So protected previews are **`manual_setup`**: the owner turns them on in their own dashboard.

## Cost and limits

From the [Pages limits](https://developers.cloudflare.com/pages/platform/limits/) page:

- The Free plan allows 1 concurrent build and 500 builds a month. Each preview build is a build.
- Retention keeps deployments from the last 30 days, the 100 most recent deployments, and the current production deployment. Previews count toward this.
- A deleted preview stops resolving at its hash URL.

## Policy states (`pipeline/pages-preview-policy.mjs`)

| State | Pages config | #84 capability |
| --- | --- | --- |
| `off` | `none` | `available_opt_in` |
| `scoped` | `custom`; includes exactly `launch-and-own/site-*`; excludes exactly `main` | `active_verified` (public previews) |
| `unsafe_all` | `all` | `active_verified` (every branch public) |
| `unsafe_custom` | `custom` with any other patterns | `active_verified` (needs review) |
| `unknown` | not Git-connected | `not_available` |

[Branch build controls](https://developers.cloudflare.com/pages/configuration/branch-build-controls/) check excludes first, then includes. A branch that matches neither is skipped. In the scoped policy, only the update-proposal branches from merged #31 get previews.

## Flow: detect → explain → approve → apply → verify

1. **Detect** (read-only): `classifyPreviewPolicy(project)` on a project the owner already owns. Owned-site discovery belongs to #39.
2. **Explain**: show `previewExposureNotice(project)`, which covers public links, branch scope, build allowance, manual Access setup, and how to turn previews off.
3. **Approve**: `planPreviewPolicy(project, expected, 'enable_scoped' | 'disable')` returns the exact PATCH and a SHA-256 `digest`. The digest binds the action, project id, repo id, the observed config and the target. The owner approves that digest in the browser. An agent instruction is not approval.
4. **Apply**: `applyPreviewPolicy(...)` first re-reads the project and re-checks the fences: Git source, owner, `repo_id`, production branch `main`, and production deployments on. It refuses a stale digest, sends one PATCH, then re-reads.
5. **Verify**: it succeeds only when the re-read classifies as the target state. Otherwise it reports `pages_preview_verify_failed`.

## Release gates (before any caller exists)

- [ ] Trial PATCH semantics on an **owner test project**. The plan resends the writable Git fields provisioning uses, so a replace-style PATCH can't drop the Git link. This hasn't been run against the live API yet.
- [ ] Owner and Domain approval for the trial write, then orchestration review (#83).
- [ ] UI/route: #87 dashboard card or #30 update page, coordinated with `onboarding/worker.mjs` owners.
- [ ] Disable path tested live. Explain that already-built preview URLs keep working until those deployments are deleted.
- [ ] Never switch provisioning from `none` to `all`.
