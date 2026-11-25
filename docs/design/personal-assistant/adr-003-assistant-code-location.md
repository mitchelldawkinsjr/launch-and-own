# ADR-003: Where the assistant's code lives

- **Status:** Proposed
- **Blocks:** M0 decision "Assistant location" in #165
- **Date:** 2026-11-24 · Claude Opus 5.5

## Options

### A. A directory in the website repo (for example `/.assistant`)
- **For:** one repo, so setup is simpler.
- **Against:**
  - **Exposure through Pages.** Imported static sites often publish from the repo root with no build step, so every file, including `wrangler.jsonc`, assistant source and migration SQL, becomes public. Excluding it depends on each site's output directory setting, which we can't guarantee for imported ZIPs.
  - **The assistant can rewrite itself.** The GitHub App needs Contents: write on the website repo, so an approved (or injected) edit could change the assistant's own code. That would need an extra path rule that is easy to get wrong.
  - Changes to the assistant trigger Pages builds, which use up the 500 builds/month allowance.
  - Mixing customer site files with versioned product code makes updates (ADR-004) harder.

### B. A separate private repo generated from a versioned upstream template (recommended)
The upstream template is a public, auditable Launch & Own repo with tagged releases. The customer's copy is **private** and holds their `wrangler.jsonc` with account, D1 and Access IDs. No secrets ever go in either repo.
- **For:**
  - Never part of Pages output.
  - The customer's GitHub App is **not** installed on the assistant repo, so the assistant can't change its own code. Only the owner merges assistant changes.
  - A clean update channel: the update PR goes to this repo.
  - Private repos are available on GitHub Free.
- **Against:** one more repo to explain, and the setup script has to create it from the template.

### C. No repo: deploy a pinned release artifact
`wrangler deploy` runs from a downloaded release tarball that is checked by digest.
- **For:** nothing extra in GitHub.
- **Against:** no customer-visible history or diff of what's running, and config drift lives only on the customer's machine. It's also harder for the owner to review updates.

## Decision (proposed)

**B.** Use a separate private repo per customer, generated from a tagged upstream template. The GitHub App is installed only on the website repo, never on the assistant repo. Deploys are customer-run (ADR-001).

Rules for the template:
- No secrets, no `vars` holding sensitive values (Cloudflare advises against it), and no Launch & Own URLs that are needed at runtime.
- A `VERSION` file plus the upstream commit SHA, recorded in the deployed Worker as build metadata and shown on the dashboard.
