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

## Develop and test

Node.js 22+ required:

```sh
npm test
node --check onboarding/worker.mjs
npm run preflight:onboarding
```

Tests use simulated provider APIs and an in-memory D1-compatible SQLite adapter. Passing tests do **not** establish real customer OAuth or deployment.

## Domain and OAuth agent handoff

If another agent manages `*.mitchelldawkins.com`, give them [**the domain + OAuth handoff checklist**](docs/HANDOFF_DOMAIN_OAUTH.md). It specifies only the proposed `onboard.mitchelldawkins.com` hostname, exact GitHub/Cloudflare callback URLs, Cloudflare domain-publisher TXT verification, required permissions, owner approvals, and the nonsecret acceptance report. **Do not create a wildcard DNS record or publish OAuth visibility without owner approval.**

## Operator onboarding prerequisites

Before enabling hosted onboarding, register a GitHub App and Cloudflare OAuth client with minimally sufficient permissions, configure an owned HTTPS callback domain, use the independently created beta onboarding D1 database, apply `onboarding/migrations/0001_initial.sql`, and install Worker secrets using a secure provider secret store. Cloudflare's own Workers & Pages GitHub App must also be authorized for the customer's repository. Read [onboarding/README.md](onboarding/README.md).

The beta onboarding D1 is now provisioned and migrated under a dedicated Launch & Own database binding. This nonsecret identifier is recorded in `onboarding/wrangler.jsonc`. Real hosting remains blocked on approved OAuth app registrations, secret configuration, and a verified HTTPS onboarding hostname. Never replace this with another customer's database.

## Project status

- Reusable planner and website-only provisioner: **CI-tested**.
- GitHub/Cloudflare authorization-code and PKCE primitives: **CI-tested**.
- Dedicated Launch & Own beta onboarding D1: **created and schema-verified**.
- Hosted onboarding Worker source, including logout and provider revocation attempts: **CI-tested, not deployed**.
- Independent live customer login/provisioning/deployment: **not yet verified**.
- Customer-specific forms, custom domains, and AI website generation: **future milestones**.
- No license has been selected yet: this is publicly visible source, **not automatically an open-source grant**.

**Product:** Launch & Own · **Tagline:** Describe it. Launch it. Own it.
