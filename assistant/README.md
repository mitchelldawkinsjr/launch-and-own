# Customer-owned website assistant (M2 proof of concept)

**Planned, not released.** This code runs entirely in the customer's own GitHub and Cloudflare accounts. Launch & Own holds no credentials for it and plays no part at runtime. The design is in [`docs/design/personal-assistant/`](../docs/design/personal-assistant/README.md), and the build is tracked in #195. `distribution/release-matrix.json` decides availability.

## Setup (customer-run, ADR-001 B1 and ADR-002 A3)
1. Create a **private** assistant repo from the upstream template. Copy `template/UPSTREAM.example.json` to `assistant/UPSTREAM.json`, and copy `template/.github/workflows/` to the repo root.
2. `npx wrangler login` (Node ≥ 22.12), then `npx wrangler d1 create lo-assistant-<site>` and `npx wrangler d1 migrations apply DB --remote`.
3. Copy `wrangler.example.jsonc` to `wrangler.jsonc` and fill it in. Run `npx wrangler secret put KEK` with a random value of 32 characters or more, then `npx wrangler deploy`. Until Access is configured, every route except `/healthz` returns 503.
4. In the Cloudflare dashboard, create an **Access application** for the assistant hostname that allows **only your email**. Put its team domain, AUD and your Access `sub` into `wrangler.jsonc`, then redeploy.
5. Run `node assistant/setup/manifest-exchange.mjs --name <site>-assistant --origin https://<assistant-host> --repo <owner>/<website-repo>` and open the printed local address. This creates your private GitHub App. Its key goes straight into the Worker secret `GH_APP_PRIVATE_KEY`. Install the App on **only** the website repo, then set `GH_APP_ID`, `GH_INSTALLATION_ID` and `WEBSITE_REPO_ID`.
6. Open `/status` and run **Self-check**: Access ok, GitHub ok (read-only).
7. Optional: in the assistant repo only, turn on *Allow GitHub Actions to create and approve pull requests*. The weekly check then opens update PRs for security, breaking-change and end-of-support releases. Otherwise the dashboard tells you about updates.

## Uninstall
In GitHub, delete the App (that also removes its installation). In Cloudflare, delete the Worker, the `lo-assistant-<site>` D1 database and the Access application. Run `npx wrangler d1 export` first if you want your approval history. The website repo and its pull requests stay as they are. Delete any `launch-and-own/edit-*` branches if you like.
