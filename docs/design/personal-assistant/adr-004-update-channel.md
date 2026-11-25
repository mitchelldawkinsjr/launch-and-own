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
  2. If a newer **supported** release exists, and its provenance checks pass (see below), it opens a PR using the repo's own `GITHUB_TOKEN` (no external credentials). The PR updates the template files, `VERSION` and the pinned upstream SHA, and includes the release notes and migration notes.
  3. The owner merges it and deploys (ADR-001 B1 or B2).

  Option A depends on GitHub Actions behaviour. The checks below must pass before we rely on it (M2 tests T-UPD-3..5).

### GitHub Actions behaviour Option A depends on

| Behaviour | What GitHub's docs say | Consequence for the design |
| --- | --- | --- |
| Can a workflow open PRs? | New personal repos default to "workflows are not allowed to create or approve pull requests", and `GITHUB_TOKEN` gets read-only `contents` ([Actions settings](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository), read 2026-11-25) | Setup must ask the owner to turn on **"Allow GitHub Actions to create and approve pull requests"** for the *assistant* repo only. It's listed on the consent screen. The workflow requests `contents: write` and `pull-requests: write` in its own `permissions:` block. If the owner declines, the dashboard uses option B. The workflow never approves its own PR. |
| Does CI run on the update PR? | Events from `GITHUB_TOKEN` don't create new runs. The exception is `pull_request` opened, synchronize and reopened, which create runs in an **approval-required** state. A push with `GITHUB_TOKEN` triggers nothing ([GITHUB_TOKEN](https://docs.github.com/en/actions/concepts/security/github_token), read 2026-11-25). | CI checks on an update PR wait until the owner approves the run. This is desirable: owner review comes first. The PR body says so. Deploys never trigger from the bot's activity, only from the owner's merge (a user event) or a manual deploy. |
| Can it change workflow files? | `GITHUB_TOKEN` permission keys include `contents` and `pull-requests` but **no `workflows` key** in the list we read. Whether it can write `.github/workflows/*` is **unverified**. | Design for "it can't". Update PRs never touch `.github/workflows/`. A release that changes the update workflow itself ships that change as a separate, clearly labelled manual step in the release notes, which the owner applies with their own credentials. T-UPD-4 confirms GitHub's behaviour either way. |
| Actions cost on private repos | GitHub Free includes $12/month of compute for private repos. Without a payment method, usage is **blocked** (not billed) after that ([Actions billing](https://docs.github.com/en/billing/managing-billing-for-your-products/managing-billing-for-github-actions/about-billing-for-github-actions), read 2026-11-25). | A weekly check of under 1 minute on Linux uses a tiny fraction of that. If Actions is blocked or disabled, option B is used. |
- **B. A notice on the dashboard plus a manual update.** The Worker reads the public upstream releases feed without authentication and shows "Update available". The owner runs `scripts/update` locally, which performs the same provenance checks. It's the fallback when Actions is disabled or blocked, or when the owner hasn't allowed Actions to open PRs.
- **C. A central Launch & Own bot opens PRs.** Rejected: it would need central write access to customer repos.
- **D. Floating version or auto-deploy on merge.** Rejected: it breaks pinning and owner review.

## Decision (proposed): A, with B as the fallback

### Version pinning
- The customer's repo pins `VERSION` (semver) and `UPSTREAM_SHA`. No ranges or branches.
- The deployed Worker reports its version and SHA on its owner-only `/status` route. The M2 test plan checks that it matches the merged commit.

### Release provenance: what's trusted, and why

**Release titles and notes can still be edited after publishing**, even on immutable releases. So nothing in them is trusted for identity. Earlier drafts had the workflow compare the tag against a SHA listed in the release notes. That's withdrawn, because whoever can edit the notes can change both values together.

Trust comes from things that can't be changed after publication:

1. **The upstream repo's identity is pinned in the customer's repo** by owner and name, and by numeric repo ID. It's set at setup and changes only through an owner-merged PR.
2. **Releases are immutable.** Once published, "its associated Git tag is locked to a specific commit, cannot be changed, and cannot be deleted while the release exists", the assets can't be modified, and a deleted tag name can't be reused ([Immutable releases](https://docs.github.com/en/code-security/supply-chain-security/understanding-your-software-supply-chain/immutable-releases), read 2026-11-25). The update workflow refuses releases that aren't marked immutable.
3. **Attestations.** GitHub generates a *release attestation* for an immutable release, recording the tag, commit SHA and assets. Upstream CI also attests the template tarball with `actions/attest@v4`. Before opening the PR, the workflow runs two checks:
   - `gh release verify-asset <tag> <tarball> -R <pinned upstream>`, against the release attestation
   - `gh attestation verify <tarball> --repo <pinned upstream> --signer-workflow <pinned upstream>/.github/workflows/release.yml`, against the build attestation

   It records the attested commit SHA as `UPSTREAM_SHA`. The workflow uses `--repo`, not `--owner`, because the manual describes `--owner` as an *organization* scope ([gh attestation verify](https://cli.github.com/manual/gh_attestation_verify), [gh release verify-asset](https://cli.github.com/manual/gh_release_verify-asset), read 2026-11-25).
4. **Signer-workflow pinning.** `--signer-workflow` (confirmed in the gh manual) ties the attestation to the upstream release workflow file. A build attested by any other workflow in the upstream repo fails.
5. **Release order.** Upstream follows draft → attach assets → publish, so the immutability lock covers the assets, as GitHub recommends.

If any check fails, no PR is opened and the dashboard shows "update could not be verified" (T-UPD-2, T-UPD-5).

**Availability.**
- *Confirmed:* GitHub's pricing table lists artifact attestations on Free for **public repositories**, so the upstream template must be public. ADR-003 already plans that. The customer's private repo only *verifies* attestations; it doesn't create them.
- *Unverified:* whether immutable releases can be enabled on a repo owned by a free personal account. GitHub's enablement page (Settings → Releases → "Enable release immutability", which applies to future releases only) states no plan requirement. Domain should confirm this on the real upstream repo **before its first release** (T-UPD-6).

If immutable releases are unavailable, the fallback is a **signed tag** with the release key's fingerprint pinned in the customer's repo at setup. That's weaker, because key custody moves to Domain.

**Residual risk.** Someone who controls the upstream repo *and* its release workflow can publish a malicious release that verifies correctly. The protection against that is owner review of every update PR, Domain sign-off before release, and no auto-deploy. Provenance checks prove where a release came from, not that it is safe.

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
