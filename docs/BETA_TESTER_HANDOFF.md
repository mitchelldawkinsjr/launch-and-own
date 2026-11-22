# Browser beta tester handoff — Launch & Own

**Describe it. Launch it. Own it.**

**Who this is for:** a willing beta tester who wants to try making a basic one-page business website without writing code. This is a real hosted **beta**, not a production-tested customer launch or a public ChatGPT plugin.

## Start here: no Node.js, Git commands, or API keys

Open **https://onboard.360web.cloud** in a normal browser. Launch & Own's public GitHub App and verified public Cloudflare OAuth client are available for customer consent. The website creation/deployment path is still undergoing its first independent-customer acceptance test; **a successful public website is not yet guaranteed**.

Before starting, have:

- Your own **GitHub account** and **Cloudflare account**. You remain the owner of the resulting private GitHub repository and Cloudflare Pages project if the launch succeeds.
- A basic business name, headline, description, service list, and (optional) public contact email. A **one-page** site is supported by the hosted beta; bespoke AI design and contact forms are not.
- A few minutes to review both providers' permission screens and your **exact website preview before approval**.

No payment details, ChatGPT paid account, Node.js, Git installation, or pasted OAuth/API tokens are needed for this browser flow. Providers can have plan limits and charges for optional services; do not opt into paid features without checking the provider's terms.

## Walkthrough: from description to approval

1. Visit **https://onboard.360web.cloud** and choose **Connect GitHub**. Review the GitHub App consent. The app currently requests **Repository creation: read/write**, **Contents: read/write**, **Pull requests: read/write**, and **Metadata: read**, for the purposes shown in the consent screen. An existing authorization may ask you to accept newly added permissions. If the scopes shown differ, stop and report the discrepancy; do not bypass the prompt.
2. **Install the Launch & Own GitHub App** on the same personal GitHub account you authorized. Use **Install on GitHub** if setup shows it, or open the installation page directly. Review GitHub's repository access options, then return to Launch & Own and refresh setup. [Install Launch & Own](https://github.com/apps/launch-and-own/installations/new)
3. Choose **Connect Cloudflare** and follow the separate Cloudflare OAuth consent. The expected capabilities are account settings **read**, Pages **read/write**, and an offline refresh grant; check exactly what your provider displays.
4. Select the Cloudflare account you actually control. The site is not created by signing in or selecting an account.
5. Enter your business name, homepage headline, about section, services and theme in the manual form. Optional AI copy drafting is **not enabled by default**; manual editing is the supported zero-model-cost path.
6. Select **Generate website preview**. Open the **exact website preview**, examine the visible copy and contact details, and review the proposed private GitHub repository and public `pages.dev` URL.
7. Only when everything is correct, use the separate **Approve and create website** control. This authorizes the stated repository and Pages operations, not arbitrary subsequent edits. Do **not** approve merely to test whether sign-in works; use preview-only if you do not want resources created.
8. If a launch is queued, pending or paused, use **Review** or **History** to check its state and reapprove the same pending launch where offered. Do not repeatedly approve new site names or authorize extra applications as a workaround.
9. If the public website appears, treat it as **verified only after** the beta QA team confirms that the live Cloudflare Pages production deployment matches the exact approved GitHub commit and homepage SHA-256. A visible URL or HTTP 200 by itself is not proof.

**Important:** Cloudflare's **Workers & Pages** GitHub App is *different* from the Launch & Own GitHub App. Cloudflare Pages may require you to install or grant that Cloudflare-owned GitHub App access to the **new private site repository** before its build can start. Review the provider screen and grant only the repository access you intend.

## Common beta blockers

| What you see | What to do |
| --- | --- |
| GitHub asks for additional permissions | Review the provider's updated consent, particularly Repository creation and Pull requests; allow only if you agree |
| **Install on GitHub** prompt or `github_http_403_need_administration_write_repository_creation_write` | Check that **Launch & Own** is installed on the personal account you connected. Return to setup after installing and reapprove the same launch from **History** when offered. [GitHub installations](https://github.com/settings/installations) |
| GitHub or Cloudflare connect did not finish | Retry the connection from the official onboarding page; do not paste codes or tokens into an issue |
| Cloudflare account not selected | Select the account you own before creating a preview |
| `needs_reauthorization` or a provider 401/403 | The authorization may lack the permission newly required by the app. Reconnect and review consent; if it remains blocked, report the safe status/error code to QA. Avoid duplicate launches |
| Previewed copy looks wrong | Return to the editor and fix it before approval; no publication has occurred |
| Pending Pages deployment | Confirm Cloudflare's Workers & Pages GitHub App has access to your **specific private repository**; leave deployment verification to QA |
| Site URL responds but approved revision is not confirmed | Treat the launch as pending; the QA team checks both canonical commit and exact HTML SHA-256 |
| Want to change a previously launched site | The authenticated update editor and approved GitHub PR flow are in [draft PR #31](https://github.com/mitchelldawkinsjr/launch-and-own/pull/31). They are **not yet available on the live site** and require a separate release and test |

If a permissions prompt appears unexpected, pause rather than guessing. The beta is designed so you own the resources, control approval, and can decline consent.

## Send helpful, privacy-safe beta feedback

Report a blocker on [Issue #21 (beta acceptance)](https://github.com/mitchelldawkinsjr/launch-and-own/issues/21), or use the [coordination hub #2](https://github.com/mitchelldawkinsjr/launch-and-own/issues/2). Share a short sequence of steps, the **safe status or error code**, and whether the issue occurred before preview, at approval, or during deployment.

**Never post** your access or refresh tokens, OAuth authorization code, cookies, encryption keys, private account IDs, sensitive business details, or customer contact information. Screenshots should omit browser address query parameters, provider consent codes, and private data. Only approve publication of a real website and any resulting public URL with the owner's consent.

## Optional developer/offline demo (separate from the browser beta)

The repository includes a **zero-account localhost demo** for technically comfortable testers. This is not needed to use the hosted browser flow and does not publish anything.

1. Use Node.js **22.5+** and clone `https://github.com/mitchelldawkinsjr/launch-and-own`.
2. In the repository directory, run:

```sh
npm run demo:export
npm run demo:serve
```

3. Open **http://127.0.0.1:4173/** on that same computer. The default fictional Willow Studio example has **four pages**; the browser beta currently launches **one-page sites**.

To preview your own input locally, use a **new** output folder:

```sh
node scripts/export-preview.mjs --input path/to/your-brief.json --out ./site-preview-my-biz
node scripts/serve-preview.mjs --dir ./site-preview-my-biz --port 4173
```

The exporter intentionally refuses to overwrite an existing folder. For details see [offline preview notes](OFFLINE_BETA_PREVIEW.md). Neither this demo nor passing automated tests proves that a customer-backed website was launched.

## Verification and product limits

- **Confirmed by Domain/OAuth:** GitHub App public, Cloudflare OAuth client public/verified, hosted domain with TLS, provider sign-in/account selection and session-based form actions.
- **Not yet independently accepted:** real one-page customer repository creation, Cloudflare Pages deployment and exact approved public HTML verification. Follow [Issue #21](https://github.com/mitchelldawkinsjr/launch-and-own/issues/21).
- **In development:** customer-facing post-launch edits and owner-approved PR flow ([draft PR #31](https://github.com/mitchelldawkinsjr/launch-and-own/pull/31)); hosted multi-page editor.
- **ZIP upload** has merged code and awaits hosted rollout and live acceptance. [Issue #45](https://github.com/mitchelldawkinsjr/launch-and-own/issues/45)
- **Not offered today:** a public ChatGPT plugin/store listing, automated contact forms, custom customer domains, or an assurance of permanently free usage. Each provider's own terms and quotas apply.
- **License:** the repository is publicly visible but no reuse license has been selected. Public GitHub visibility does not alone grant reuse rights.
