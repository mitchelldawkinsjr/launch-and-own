# Launch & Own

**Describe it. Launch it. Own it.**

Launch & Own is a customer-owned conversational website launch and maintenance platform in development. Its goal is to help people describe, preview, publish, and update websites using their own GitHub and Cloudflare accounts—without needing to write code.

> **Beta source, not a live self-service website builder.** Automated provisioning, OAuth libraries, security tests, and an onboarding Worker exist. Provider OAuth applications, customer-facing domain, and live second-customer acceptance are not yet complete. AI-generated designs, per-customer contact forms, custom domains, and a public ChatGPT plugin are not available end-to-end.

## Customer experience we're building

1. **Describe:** Explain what your website needs, in ordinary language.
2. **Connect:** Authorize GitHub and Cloudflare through their consent screens; never paste API keys into chat.
3. **Preview:** Review the proposed website, hosting, and resource plan.
4. **Approve:** Explicitly authorize resource creation and any public exposure.
5. **Launch:** Provision resources and verify the **exact approved GitHub commit** serves on Cloudflare Pages.
6. **Maintain:** Request updates conversationally through a reviewed, tested change.

Customers keep ownership of their GitHub repositories and Cloudflare resources. Low/no-cost hosting is a design goal, subject to provider tiers, quota limits, and usage.

## Source layout

| Path | Purpose |
| --- | --- |
| `pipeline/` | Customer planning, guarded GitHub and Cloudflare provisioning, OAuth primitives, deployment verification and tests |
| `onboarding/` | Standalone, currently unhosted OAuth onboarding Worker, D1 migration, account selection, encrypted session, approval and retry |
| `.github/workflows/test.yml` | Independent product CI |
| `EXPORT-MANIFEST.json` | Provenance and customer-data exclusions |

**This repository does not contain the reference customer's website or contact form.** It is a product-only extraction from the existing verified reference implementation; the original site's GitHub repository and Cloudflare Pages connection remain unchanged.

## Try a website locally without cloud accounts

You can inspect a genuine four-page website **before OAuth onboarding is live**. The zero-dependency [offline preview exporter](docs/OFFLINE_BETA_PREVIEW.md) builds the same HTML used by the production provisioner without GitHub/Cloudflare credentials, AI inference or publishing anything.

```sh
npm run demo:export
npm run demo:serve
```

Open `http://127.0.0.1:4173/` on the same computer. The server exposes only known static HTML routes on localhost; the output is ignored by Git. You can also supply your own JSON brief with `node scripts/export-preview.mjs --input <input-file> --out <new-directory>`. The exporter refuses to overwrite an existing directory. The generated manifest includes SHA-256 hashes for individual pages and the full approved bundle digest, but generating a preview is **not** a customer launch approval.

## Develop and test

Node.js 22+ required:

```sh
npm test
node --check onboarding/worker.mjs
npm run preflight:onboarding
```

Tests use simulated provider APIs and an in-memory D1-compatible SQLite adapter. Passing tests do **not** establish real customer OAuth or deployment.

## Domain and OAuth agent handoff

If another agent manages the Cloudflare zone for `360web.cloud`, give them [**the domain + OAuth handoff checklist**](docs/HANDOFF_DOMAIN_OAUTH.md). It specifies only the selected `onboard.360web.cloud` hostname, exact GitHub/Cloudflare callback URLs, Cloudflare domain-publisher TXT verification, required permissions, owner approvals, and the nonsecret acceptance report. **Do not create a wildcard DNS record or publish OAuth visibility without owner approval.**

**Current domain rollout status:** The domain agent has verified the `360web.cloud` zone active and registered beta app client IDs. OAuth client configuration/secrets, Worker routing/TLS and an independent live acceptance test remain outstanding. The onboarding service should not yet be represented as publicly available.

## Optional AI-assisted website copy

Customers can enter a plain-language business brief and ask for an **editable first draft** of their headline, about section and service labels. AI output is strictly validated as structured text, not HTML/JavaScript. The customer's supplied business name, theme and contact email remain under their control. The draft is **never provisioned or saved as an approved plan** until the customer submits a separate preview and explicitly approves it. The manual editor works without AI.

This option is **disabled unless the backend operator configures** an approved Cloudflare Workers AI binding named `AI` and a model identifier in `SITE_AI_MODEL`. Inference can incur usage charges; no AI binding is automatically enabled or deployed by this repository. See [onboarding setup](onboarding/README.md). The domain/OAuth agent owns the Wrangler file and must coordinate configuration with the product owner.

## Reviewable website updates (backend foundation)

Once a site is live, a proposed content update should **not** overwrite its live GitHub branch directly. The reusable [safe website updates](docs/SAFE_WEBSITE_UPDATES.md) module accepts the exact customer-reviewed site HTML digest and GitHub base commit, verifies immutable owner identity and the private managed repository, and opens/reuses a separate feature-branch pull request. The customer reviews and merges the PR; Cloudflare production must then be verified against the merged SHA. This module is CI-tested but **not yet wired into the onboarding UI**. The domain agent must coordinate the additional GitHub App **Pull requests: write** permission before live use.

## Operator onboarding prerequisites

Before enabling hosted onboarding, register a GitHub App and Cloudflare OAuth client with minimally sufficient permissions, configure an owned HTTPS callback domain, use the independently created beta onboarding D1 database, apply `onboarding/migrations/0001_initial.sql`, and install Worker secrets using a secure provider secret store. Cloudflare's own Workers & Pages GitHub App must also be authorized for the customer's repository. Read [onboarding/README.md](onboarding/README.md).

The beta onboarding D1 is now provisioned and migrated under a dedicated Launch & Own database binding. This nonsecret identifier is recorded in `onboarding/wrangler.jsonc`. Real hosting remains blocked on approved OAuth app registrations, secret configuration, and a verified HTTPS onboarding hostname. Never replace this with another customer's database.

## Project status

- Reusable planner and website-only provisioner: **CI-tested**.
- **Editable business-site content and live HTML preview:** CI-tested. Customers can enter a headline, about text, services, contact email and color theme, view the exact generated HTML before approval, then publish it. This is a deterministic template, **not AI-generated multi-page design**.
- GitHub/Cloudflare authorization-code and PKCE primitives: **CI-tested**.
- Dedicated Launch & Own beta onboarding D1: **created and schema-verified**.
- Hosted onboarding Worker source, including logout and provider revocation attempts: **CI-tested, not deployed**.
- Independent live customer login/provisioning/deployment: **not yet verified**.
- **Optional AI-assisted business copy drafts:** structured, validated and editable before private preview/approval; available only after an authorized Workers AI binding/model is configured. This does **not** generate bespoke multi-page designs.
- **Reviewable update proposal module:** CI-tested, approval-digest-pinned GitHub feature branches and PRs for existing managed sites; not yet connected to the hosted UI.
- **Opt-in four-page site bundles:** CI-tested Home/About/Services/Contact renderer, full-bundle SHA-256 approval and safe idempotent provisioning; **not yet connected to the onboarding UI**. See [multi-page bundle design](docs/MULTIPAGE_SITE_BUNDLES.md).
- Customer-specific forms, custom domains, image generation and fully bespoke AI website design: **future milestones**.
- No license has been selected yet: this is publicly visible source, **not automatically an open-source grant**.

**Product:** Launch & Own · **Tagline:** Describe it. Launch it. Own it.
