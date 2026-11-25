# ADR-004: How deployed assistants get updates

- **Status:** Proposed
- **Blocks:** M0 decision "Update channel" (WS4) in #165
- **Date:** 2026-11-24 · Claude Opus 5.5

## Constraints
- Customer-owned. **Launch & Own can't push code to, deploy into or remotely disable a customer's assistant.** That rules out a central kill switch.
- Every update is a diff the owner reviews and merges, with an exact version and SHA.
- It has to work with Launch & Own offline. The only external dependency is GitHub, where the upstream repo and the customer's own repo already live.

## Options
- **A. A scheduled workflow in the customer's private assistant repo (recommended).**
  1. Once a week, a workflow reads the upstream template's public releases.
  2. If a newer **supported** release exists, it opens a PR using the repo's own `GITHUB_TOKEN` (no external credentials). The PR updates the template files, `VERSION` and the pinned upstream SHA, and includes the release notes and migration notes.
  3. The owner merges it and deploys (ADR-001 B1 or B2).

  The workflow file itself is part of the template and only changes through those PRs. Free Actions minutes for private repos are **unverified**, so the job must stay small, and the dashboard covers it if Actions is disabled.
- **B. A notice on the dashboard plus a manual update.** The Worker reads the public upstream releases feed without authentication and shows "Update available". The owner runs `scripts/update` locally. It's the fallback when Actions isn't available.
- **C. A central Launch & Own bot opens PRs.** Rejected: it would need central write access to customer repos.
- **D. Floating version or auto-deploy on merge.** Rejected: it breaks pinning and owner review.

## Decision (proposed): A, with B as the fallback

### Version pinning
- The customer's repo pins `VERSION` (semver) and `UPSTREAM_SHA`. No ranges or branches.
- Upstream releases are annotated tags. The release notes list the exact SHA and the digest of the template tarball. The update workflow checks that the tag resolves to the listed SHA before it opens the PR.
- The deployed Worker reports its version and SHA on its owner-only `/status` route. The M2 test plan checks that it matches the merged commit.

### Database migrations and rollback
- D1 migrations are forward-only and additive within a major version. Each release must still run on the schema of the previous release (N-1).
- That lets rollback be `wrangler rollback` to the previous Worker version without touching D1. Destructive schema changes only happen in a major version, with an export step first.

### Security-fix policy
- Advisories are published as GitHub Security Advisories on the upstream repo, with the affected version ranges.
- The dashboard checks the public advisory feed and shows a banner when the running version is affected. The update workflow labels the PR `security`.
- **Target times, not guarantees:** critical (credential exposure, auth bypass) has a release within 72 hours of confirmation; high within 14 days; others in the next minor release.
- Because there is no remote kill switch, the advisory text must give the owner a **local mitigation** for anything critical. Examples: uninstall the GitHub App, use the owner-only maintenance toggle (which stops all GitHub writes and inference), or `wrangler delete`.

### Deprecation policy
- Supported versions are the current minor and the previous minor of the current major.
- When a version is deprecated, there's at least 90 days' notice through release notes and the dashboard banner before it is end-of-life.
- An end-of-life assistant keeps working; we never break it remotely. The dashboard says it is unsupported and links to the update PR or guide.

### Who does what
- Upstream releases are signed off by Domain. 360Web paid services can apply updates for a customer only inside the customer's own session.
