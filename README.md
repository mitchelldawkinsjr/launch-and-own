# Launch & Own

**Describe it. Launch it. Own it.**

Launch & Own is a customer-owned website launch and maintenance platform with **two first-class entry points**: a planned ChatGPT conversational builder/manager and a standalone web onboarding experience for ZIP uploads or manual site creation. Both use the same GitHub/Cloudflare account ownership, preview, approval and publication backend.

> **Hosted browser beta — independent customer acceptance still under QA.** Visit **https://onboard.360web.cloud** to connect your own GitHub and Cloudflare accounts and inspect a one-page website preview. The owner-account B13 rehearsal has created a private GitHub repository and a successful Cloudflare Pages production deployment at the approved commit. Approved HTML matches the repository bytes. **The owner B13 job has since reached `live`, and public HTML SHA-256 matches the approved bytes; a separately consenting customer's launch and approved website edit remain pending** ([Issue #21](https://github.com/mitchelldawkinsjr/launch-and-own/issues/21)). A green CI run or successful Pages build alone is not end-to-end acceptance. Custom forms/domains, bespoke AI designs and a public ChatGPT plugin are not available end-to-end.

**Portable instructions-only Agent Skill:** [skills/launch-and-own/SKILL.md](skills/launch-and-own/SKILL.md) is available to compatible agents for preparation and safe browser handoff. It is **not** an authenticated Claude/ChatGPT publishing connector.

**For agent and connector builders:** [the shared distribution/release contract](docs/AGENT_DISTRIBUTION_RELEASE.md) tracks portable skills, Claude/ChatGPT connectors, owner-approval gates, and beta verification independently. Run `npm run qa:distribution` for current machine-checked status. Skills-only instructions are not authenticated publishing tools.

## Two ways to build and manage a website

**ChatGPT flow (planned integration):** ask to create a site or make changes in conversational language; ChatGPT proposes copy/design changes and hands a structured plan to Launch & Own. The customer sees the **exact prepared site**, authorizes their own GitHub/Cloudflare accounts through official consent, separately approves publication, and receives verified deployment status. The current private `elite-site-pipeline` ChatGPT plugin is **skills-only** without hosted MCP/API tools; this production integration is tracked in [Issue #43](https://github.com/mitchelldawkinsjr/launch-and-own/issues/43).

**Standalone web flow (hosted browser beta):** visit **https://onboard.360web.cloud** to create a simple one-page site **or upload a static website ZIP**, privately preview exact content and separately approve launch. Domain completed a real owner-consented ZIP upload and multi-page publication with **5/5 files matching the public Pages deployment** ([#45 evidence](https://github.com/mitchelldawkinsjr/launch-and-own/issues/45#issuecomment-7087063896)); independent customer acceptance is still pending. A near-limit upload took 95 ms Worker CPU ([#45 measurement](https://github.com/mitchelldawkinsjr/launch-and-own/issues/45#issuecomment-7087096052)), which may exceed free-tier CPU allowances. No ChatGPT or paid AI model is needed for the browser path. UI improvements are tracked in [#41](https://github.com/mitchelldawkinsjr/launch-and-own/issues/41).

**Shared product, not separate silos:** both entry points will use the same tenant/site ownership, provider connections, exact site preview, durable jobs and production-verification pipeline. Read the [two-flow product architecture](docs/TWO_FLOW_PRODUCT_ARCHITECTURE.md) for the complete product contract and coordination.

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

## Product and design handoff

Launch & Own has a **ChatGPT-first conversational experience (planned)** and a **standalone web experience (hosted beta)** for manually building or importing websites. Both should lead from exact preview through separate publication approval to verifiable customer-controlled hosting.

- [**Standalone web onboarding UI/UX brief**](docs/ONBOARDING_UIUX_HANDOFF.md) — mobile/desktop design direction for manual site creation, ZIP import and account screens ([Issue #41](https://github.com/mitchelldawkinsjr/launch-and-own/issues/41)).
- [**Two-flow product architecture**](docs/TWO_FLOW_PRODUCT_ARCHITECTURE.md) — ChatGPT builder + standalone website sharing one owner, source, approval and publishing platform ([Issue #43](https://github.com/mitchelldawkinsjr/launch-and-own/issues/43)).
- [**Suggested repository About profile**](.github/REPOSITORY_PROFILE.md) — public description, hosted beta URL, discoverability topics and social-preview guidance.
- [**Nontechnical beta tester guide**](docs/BETA_TESTER_HANDOFF.md) — what customers actually see, what is approved and the current live-QA limits.

## Source layout

| Path | Purpose |
| --- | --- |
| `pipeline/` | Customer planning, guarded GitHub and Cloudflare provisioning, OAuth primitives, deployment verification and tests |
| `onboarding/` | Hosted beta OAuth onboarding Worker, D1 migrations, account selection, encrypted sessions, explicit approval and recoverable launch jobs |
| `skills/launch-and-own/` | Portable instructions-only agent skill (browser handoff; not connected publishing) |
| `clients/claude-plugin/` | Thin Claude Code plugin wrapper around that skill (`claude --plugin-dir`; not marketplace-published) |
| `.github/workflows/test.yml` | Independent product CI |
| `EXPORT-MANIFEST.json` | Provenance and customer-data exclusions |

**This repository does not contain the reference customer's website or contact form.** It is a product-only extraction from the existing verified reference implementation; the original site's GitHub repository and Cloudflare Pages connection remain unchanged.

## Use standalone hosted browser onboarding — no coding needed

Open **https://onboard.360web.cloud** with your own GitHub and Cloudflare accounts. Follow the [plain-language tester guide](docs/BETA_TESTER_HANDOFF.md) to review OAuth permissions, choose a provider account, create a one-page site **or upload a static ZIP**, inspect the exact preview and decide whether to approve resource creation. **An owner-account live launch has passed exact SHA/HTML verification; independently consenting customer acceptance and post-launch editing remain open in #21.** The customer owns the resulting private GitHub and Cloudflare resources if provisioned.

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

**Remaining acceptance gate:** owner-account B13 production commit and public HTML match, but an **independent consenting customer** and an **approved edit/PR/merge/verification** must still be tested; see [Issue #21](https://github.com/mitchelldawkinsjr/launch-and-own/issues/21). Do not modify provider app permissions, OAuth clients, DNS or the live Worker during an active owner rehearsal without coordinating on [Issue #2](https://github.com/mitchelldawkinsjr/launch-and-own/issues/2).


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
- **Customer-owned private repository and Pages provisioning:** implemented with durable D1 jobs and local simulations. The **B13 owner rehearsal created a real private GitHub repository and deployed Pages at the approved commit, with matching public HTML SHA-256 and `live` job status**; independent-customer acceptance and the update flow remain [Issue #21](https://github.com/mitchelldawkinsjr/launch-and-own/issues/21).
- **Exact GitHub commit and public HTML verification:** implemented and **verified against the live owner-account B13 site** (matching full commit and SHA-256), while independent-customer acceptance is pending.
- **Optional AI-assisted website copy:** structured and editable, but unavailable unless an operator explicitly configures an approved Workers AI binding/model.
- **Reviewable website maintenance UI:** implemented and tested in [draft PR #31](https://github.com/mitchelldawkinsjr/launch-and-own/pull/31); **not yet released**.
- **Four-page Home/About/Services/Contact bundles:** deterministically rendered and locally previewable, but not exposed in the hosted editor.
- **ZIP import:** **enabled in hosted browser beta**, with owner-tested private preview, separate approval, and exact 5/5-file deployment matching ([#45](https://github.com/mitchelldawkinsjr/launch-and-own/issues/45#issuecomment-7087063896)); independently consenting customer acceptance and quota/CPU review remain open.
- **Forms, customer domains, bespoke AI design and ChatGPT plugin:** separate future milestones; not yet available end to end.
- **Offline preview/demo:** available with Node 22.5+ (developer option); see [tester handoff](docs/BETA_TESTER_HANDOFF.md).
- **Source reuse license:** not yet selected. Public GitHub visibility is not a license.


**Product:** Launch & Own · **Tagline:** Describe it. Launch it. Own it.
