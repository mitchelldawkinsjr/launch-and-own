# Launch & Own

**Describe it. Launch it. Own it.**

Launch & Own is a customer-owned conversational website launch and maintenance platform in development. Its goal is to help people describe, preview, publish, and update websites using their own GitHub and Cloudflare accounts—without needing to write code.

> **Hosted browser beta — first customer launch still under QA.** Visit **https://onboard.360web.cloud** to connect your own GitHub and Cloudflare accounts and inspect a one-page website preview. Both OAuth apps are public, and hosted sign-in/account selection is verified. **Real customer-backed repository creation and exact live deployment have not yet passed independent acceptance** ([Issue #21](https://github.com/mitchelldawkinsjr/launch-and-own/issues/21)). Don't claim a preview, passing CI or a working hostname equals a successfully launched site. Custom forms/domains, bespoke AI designs and a public ChatGPT plugin are not available end-to-end.

## Customer experience we're building

1. **Describe:** Explain what your website needs, in ordinary language.
2. **Connect:** Authorize GitHub and Cloudflare through their consent screens; never paste API keys into chat.
3. **Preview:** Review the proposed website, hosting, and resource plan.
4. **Approve:** Explicitly authorize resource creation and any public exposure.
5. **Launch:** Provision resources and verify the **exact approved GitHub commit** serves on Cloudflare Pages.
6. **Maintain:** Request updates conversationally through a reviewed, tested change.

Customers keep ownership of their GitHub repositories and Cloudflare resources. Low/no-cost hosting is a design goal, subject to provider tiers, quota limits, and usage.

## Architecture

Open [`docs/architecture.html`](docs/architecture.html) in a browser for an interactive diagram: step through a customer's journey from first visit to owning a live website, and see which part of the system (onboarding Worker, D1, GitHub, Cloudflare, customer-owned resources) handles each step. Update it when the flow changes.

## Source layout

| Path | Purpose |
| --- | --- |
| `pipeline/` | Customer planning, guarded GitHub and Cloudflare provisioning, OAuth primitives, deployment verification and tests |
| `onboarding/` | Hosted beta OAuth onboarding Worker, D1 migrations, account selection, encrypted sessions, explicit approval and recoverable launch jobs |
| `.github/workflows/test.yml` | Independent product CI |
| `EXPORT-MANIFEST.json` | Provenance and customer-data exclusions |

**This repository does not contain the reference customer's website or contact form.** It is a product-only extraction from the existing verified reference implementation; the original site's GitHub repository and Cloudflare Pages connection remain unchanged.

## Use the hosted browser beta — no coding needed

Open **https://onboard.360web.cloud** with your own GitHub and Cloudflare accounts. Follow the [plain-language tester guide](docs/BETA_TESTER_HANDOFF.md) to review OAuth permissions, choose a provider account, preview one-page content and decide whether to approve resource creation. **Hosted consent and preview are available, but a successful first real launch is still being verified in #21.** The customer owns the resulting private GitHub and Cloudflare resources if provisioned.

## Optional offline developer preview

The [offline preview exporter](docs/OFFLINE_BETA_PREVIEW.md) produces production-renderer HTML without GitHub/Cloudflare accounts, AI inference or publication. Requires **Node.js 22.5+** (`node:sqlite` is unavailable in Node 22.0.0).

```sh
npm run demo:export
npm run demo:serve
```

Open `http://127.0.0.1:4173/` on the same computer. This four-page fictional sample is **not** the hosted one-page customer launch. For a custom brief, run `node scripts/export-preview.mjs --input <input-file> --out <new-directory>` directly and choose a new folder; the exporter won't overwrite existing output. Generated hashes prove preview consistency, **not publication**.


## Develop and test

Node.js **22.5+** required (`node:sqlite`):

```sh
npm test
node --check onboarding/worker.mjs
npm run preflight:onboarding
```

Tests use simulated provider APIs and an in-memory D1-compatible SQLite adapter. Passing tests do **not** establish real customer OAuth or deployment.

## Domain and OAuth agent handoff

The [Domain/OAuth handoff](docs/HANDOFF_DOMAIN_OAUTH.md) records the authorized single `onboard.360web.cloud` host, provider callback settings, DNS/publisher checks and responsibilities. **Domain/OAuth has confirmed:** verified TLS on the custom domain; public GitHub App and Cloudflare OAuth client; successful owner sign-ins and Cloudflare account selection; GitHub App **Pull requests: write** permission separately approved and verified.

**Remaining acceptance gate:** a real customer website must provision and match its approved production GitHub commit and public HTML SHA-256; see [Issue #21](https://github.com/mitchelldawkinsjr/launch-and-own/issues/21). Do not modify provider app permissions, OAuth clients, DNS or the live Worker during an active owner rehearsal without coordinating on [Issue #2](https://github.com/mitchelldawkinsjr/launch-and-own/issues/2).


## Optional AI-assisted website copy

Customers can enter a plain-language business brief and ask for an **editable first draft** of their headline, about section and service labels. AI output is strictly validated as structured text, not HTML/JavaScript. The customer's supplied business name, theme and contact email remain under their control. The draft is **never provisioned or saved as an approved plan** until the customer submits a separate preview and explicitly approves it. The manual editor works without AI.

This option is **disabled unless the backend operator configures** an approved Cloudflare Workers AI binding named `AI` and a model identifier in `SITE_AI_MODEL`. Inference can incur usage charges; no AI binding is automatically enabled or deployed by this repository. See [onboarding setup](onboarding/README.md). The domain/OAuth agent owns the Wrangler file and must coordinate configuration with the product owner.

## Reviewable website updates (release candidate)

The reusable [safe website update module](docs/SAFE_WEBSITE_UPDATES.md) binds customer-reviewed HTML SHA-256 and an observed base commit to a managed GitHub repository and creates/reuses **only** a feature-branch pull request. The customer reviews and manually merges it; Cloudflare must then show the exact merged commit **and** approved public HTML.

Authenticated one-page editing, exact previews, separately approved PR creation and post-merge verification have been implemented and CI-tested in [**draft PR #31**](https://github.com/mitchelldawkinsjr/launch-and-own/pull/31). They are **not yet merged or deployed**. GitHub App `Pull requests: write` is now granted, but live acceptance must follow the first successful launch and a coordinated release window.


## Operator onboarding prerequisites

The beta Worker is hosted at `onboard.360web.cloud`, with a dedicated beta D1 migrated through **0004**, and configured public GitHub/Cloudflare OAuth apps. The D1 binding is recorded in `onboarding/wrangler.jsonc`; it must **never** be replaced by a customer's contact-form database. Cloudflare's separate **Workers & Pages GitHub App** still needs access to each newly created customer-owned private repository for Pages builds. See [onboarding/README.md](onboarding/README.md).

All live Worker releases are coordinated by Domain and QA on [Issue #2](https://github.com/mitchelldawkinsjr/launch-and-own/issues/2). No owner/tester should paste an OAuth code or access token into GitHub issues, screenshots or chat.


## Project status

- **Manual one-page design, preview, explicit approval:** implemented on the hosted beta.
- **GitHub and Cloudflare OAuth sign-in/account selection:** public and live-verified by the Domain/OAuth operator.
- **Customer-owned private repository and Pages provisioning:** implemented with durable D1 jobs and local provider simulations; **first real live customer deployment remains under acceptance in [Issue #21](https://github.com/mitchelldawkinsjr/launch-and-own/issues/21)**.
- **Exact GitHub commit and public HTML verification:** implemented and simulated; successful customer acceptance pending.
- **Optional AI-assisted website copy:** structured and editable, but unavailable unless an operator explicitly configures an approved Workers AI binding/model.
- **Reviewable website maintenance UI:** implemented and tested in [draft PR #31](https://github.com/mitchelldawkinsjr/launch-and-own/pull/31); **not yet released**.
- **Four-page Home/About/Services/Contact bundles:** deterministically rendered and locally previewable, but not exposed in the hosted editor.
- **ZIP import, forms, customer domains, bespoke AI design, ChatGPT plugin:** separate future or in-progress milestones; not currently available end to end.
- **Offline preview/demo:** available with Node 22.5+ (developer option); see [tester handoff](docs/BETA_TESTER_HANDOFF.md).
- **Source reuse license:** not yet selected. Public GitHub visibility is not a license.


**Product:** Launch & Own · **Tagline:** Describe it. Launch it. Own it.
