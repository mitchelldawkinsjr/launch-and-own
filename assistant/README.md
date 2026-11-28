# Customer-owned website assistant (M2 proof of concept)

**Planned, not released.** This code runs entirely in the customer's own GitHub and Cloudflare accounts. Launch & Own holds no credentials for it and plays no part at runtime. The design is in [`docs/design/personal-assistant/`](../docs/design/personal-assistant/README.md), and the build is tracked in #195. `distribution/release-matrix.json` decides availability.

## Setup paths

1. **Hosted bootstrap (owner / invite beta, no wrangler)** — when Domain enables `OPTION_ASSISTANT_BOOTSTRAP_ENABLED` on onboard: open **Your website toolkit** → **Set up private assistant** for a live site. Consent → Cloudflare `purpose=assistant` grant → create repo/D1/Worker → paste Access → paste GitHub App → open your assistant URL. See ADR-001 amendment. Flag stays off until Domain confirms scopes.
2. **Customer-run CLI (M2 reference)** — below.

## Setup (customer-run CLI)

Reference path — one script that follows [`provisioning-plan.md`](../docs/design/personal-assistant/provisioning-plan.md):

```bash
node assistant/setup/provision.mjs \
  --site-slug <slug> \
  --owner <github-login> \
  --website-repo <owner/website-repo> \
  --upstream-sha <40-hex> \
  --email <owner-email> \
  [--workers-plan free|paid] \
  [--origin https://lo-assistant-<slug>.workers.dev] \
  [--dry-run]
```

Resume after a pause or interruption:

```bash
node assistant/setup/provision.mjs --resume assistant/provisioning/state.<runId>.json
```

The script:

1. Prefights Node ≥ 22.12, `wrangler whoami`, and D1 capacity.
2. Shows a consent/cost screen (no “free forever”); type `YES` to continue.
3. Walks you through creating the private assistant repo from the pinned template, then creates D1 + migrations and deploys a bootstrap Worker with `KEK` via wrangler.
4. **Pauses** for you to create the Cloudflare Access application (email-only policy), then asks you to paste team domain / AUD / sub into `wrangler.jsonc` and redeploys.
5. Points you at [`setup/manifest-exchange.mjs`](setup/manifest-exchange.mjs) for your private GitHub App, then collects the App id/slug.
6. **Pauses** for you to install that App on **only** the website repo, then stores installation + repo ids.
7. Calls `/self-check` and writes local `provisioning/state.<runId>.json` (resource IDs and step status; never secrets).

Dry-run (`--dry-run`) touches no providers. Rollback deletes only resources this run marked as created. Access and the GitHub App stay manual checklist items — see [`UNINSTALL.md`](UNINSTALL.md). Live provider use needs owner-authorized disposable accounts first.

`npx wrangler login` is still required beforehand. Launch & Own never receives your tokens.

### Manual steps (if you prefer not to use the script)

1. Create a **private** assistant repo from the upstream template. Copy `template/UPSTREAM.example.json` to `assistant/UPSTREAM.json`, and copy `template/.github/workflows/` to the repo root.
2. `npx wrangler login` (Node ≥ 22.12), then `npx wrangler d1 create lo-assistant-<site>` and `npx wrangler d1 migrations apply DB --remote`.
3. Copy `wrangler.example.jsonc` to `wrangler.jsonc` and fill it in. Run `npx wrangler secret put KEK` with a random value of 32 characters or more, then `npx wrangler deploy`. Until Access is configured, every route except `/healthz` returns 503.
4. In the Cloudflare dashboard, create an **Access application** for the assistant hostname that allows **only your email**. Put its team domain, AUD and your Access `sub` into `wrangler.jsonc`, then redeploy.
5. Run `node assistant/setup/manifest-exchange.mjs --name <site>-assistant --origin https://<assistant-host> --repo <owner>/<website-repo>` and open the printed local address. This creates your private GitHub App. Its key goes straight into the Worker secret `GH_APP_PRIVATE_KEY`. Install the App on **only** the website repo, then set `GH_APP_ID`, `GH_INSTALLATION_ID` and `WEBSITE_REPO_ID`.
6. Open `/status` and run **Self-check**: Access ok, GitHub ok (read-only).
7. Optional: in the assistant repo only, turn on *Allow GitHub Actions to create and approve pull requests*. The weekly check then opens update PRs for security, breaking-change and end-of-support releases. Otherwise the dashboard tells you about updates; apply fix/feature releases with `node assistant/scripts/update`.

## Using it
Open the assistant's address. Prefer the visual editor: edit on the canvas, preview the changed files, then **Approve and publish** (or open a pull request). The typed Advanced path remains available for one exact text change. Every step re-reads your repository, so if the site changed in between, it asks you to start again.

Plain-language requests ("open Saturdays 10 to 4") use your own Workers AI allowance and are an **owner opt-in** (`AI_EDITS`). The default model, `@cf/openai/gpt-oss-120b`, met the 95% valid / 90% correct bar in 3 of 3 runs on the 8-case accuracy set (2026-11-26); `@cf/google/gemma-4-26b-a4b-it` is the cheaper fallback. When on, the daily budget is reserved before every model call, and the model's proposal goes through the same checks as a typed edit.

**Preview scope in M2:** the review shows each changed file exactly as it would be published, fully sandboxed. Visual drafts are stored in your assistant's D1 database. Review links expire after 15 minutes, and the next visual preview clears expired drafts. A full rendered preview on a separate address is a follow-up (preview Worker is deferred in `provisioning/manifest.json`).

## Updates
- Security / breaking / end-of-support: weekly Actions workflow opens a provenance-checked PR (ADR-004 A2).
- Fix / feature: dashboard notice; owner runs `node assistant/scripts/update` (same checks).

## Uninstall
Follow [`UNINSTALL.md`](UNINSTALL.md). Export D1 first if you want approval history. The website repo stays as it is.
