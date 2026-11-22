# Launch & Own — onboarding UI/UX redesign handoff

**Agent work item:** [#41 — redesign browser onboarding screens](https://github.com/mitchelldawkinsjr/launch-and-own/issues/41)

**Product:** Launch & Own — *Describe it. Launch it. Own it.*

**Public browser beta:** https://onboard.360web.cloud

**Repository:** https://github.com/mitchelldawkinsjr/launch-and-own

## Product story and north star

Launch & Own aims to let a nontechnical person turn basic business copy into a website using **their own GitHub and Cloudflare accounts**. They never need to paste API tokens or write code. Their website lives in their private GitHub repository and Cloudflare Pages project when provisioned, not inside a proprietary site-builder subscription.

The UX should make three promises understandable:

- **Describe it:** tell the product about a business; get an editable, deterministic one-page website.
- **Launch it:** connect the two provider accounts, inspect the exact rendered preview and proposed resources, and explicitly approve publication. No repository or Pages project is created merely by signing in or previewing.
- **Own it:** the customer owns the resources. Future changes are reviewed and approved; customer-controlled PRs must be merged manually. Post-launch editing is under development and **not released** yet.

**Release truth:** both OAuth apps are public and live sign-in/account selection is verified. The first full independent customer live deployment remains a separate QA gate in [#21](https://github.com/mitchelldawkinsjr/launch-and-own/issues/21). Do not design a UI that claims an in-progress or unverified launch succeeded.

## Your assignment: design **and implement**

Perform a visual and usability overhaul of the **existing onboarding screens** in an isolated GitHub branch and PR. Deliver real HTML/CSS/components in the current Cloudflare Worker stack, not only a screenshot or design concept. Make it feel like an approachable, polished modern product for people who have never used GitHub or Cloudflare.

The current UI is **small, server-rendered HTML** in `onboarding/worker.mjs` (shared `view(title, body, status)` function and simple HTML-form components). This is not a React/Next.js app. Preserve lightweight performance, server-side route guards, and the current no-client-JS baseline unless a minimal progressive enhancement is justified and authorized. Main code paths are `onboarding/worker.mjs`, `onboarding/worker.test.mjs`, `onboarding/worker-test-support.mjs`. Optional future update UI is in [draft PR #31](https://github.com/mitchelldawkinsjr/launch-and-own/pull/31), not on main. Read `AGENTS.md`, `docs/BETA_TESTER_HANDOFF.md`, `docs/architecture.html`, and the QA hub [#2](https://github.com/mitchelldawkinsjr/launch-and-own/issues/2) before changing anything.

## Screen map / storyboards to build

| State | Actual route or implementation hook | Customer need |
| --- | --- | --- |
| Welcome, not connected | `GET /`, no session | Clear value proposition, ownership explanation, "Connect GitHub" CTA, privacy reassurance and a visible beta label |
| GitHub connected only | `GET /`, GitHub session / `/connect/cloudflare` | Confirm connection; explain Cloudflare's role; "Connect Cloudflare" CTA; show the next step |
| Cloudflare connected, account needed | `GET /` + `POST /account` | Select a specific account; show who is connected, what that means, and why it matters |
| Design website | `GET /` + `POST /preview` | Friendly editor with business name, headline, about, services (up to six), optional email and theme selection (ocean, forest, sunset, graphite) |
| Optional AI copy | `POST /draft`, rendered editable draft | Review/edit suggestions, and a precise "AI copy, not published" label. This screen appears **only when AI is configured** |
| Exact website preview + resource review | `GET /review?id=...`, `GET /site-preview?id=...` | Inspect exact HTML, private GitHub repository target, planned public Pages URL and permission consequences; **separate** "Approve and create website" CTA |
| Launch in progress | `GET /review?id=...` with `queued`, `pending_deployment`, retry metadata | Understand progress without fictitious countdowns or invented completion percentages; offer only backend-authorized actions |
| Needs reauthorization / failed | `GET /review`, `GET /history` | Understand permission expiration or safe error code; instructions to reconnect and **review/reapprove the same launch**, not create duplicate resources |
| Verified live | `GET /review`, `GET /history` when status is genuinely `live` | Celebrate only verified SHA/digest; show website URL, link to own resources where already known, next steps and ownership |
| History and account care | `GET /history`, `POST /restore`, `POST /delete-launch-history`, `POST /logout` | See own launches, distinguish 30-day history from the website's lifetime, restore/approve and disconnect safely |
| Error and disconnect notices | shared `fail()`, `GET /?disconnect=...` | Calm, actionable copy, accessible alerts, no leaked technical internals, no false success |
| Future: customer-approved updates | *not yet live*, [#31](https://github.com/mitchelldawkinsjr/launch-and-own/pull/31) | Design compatible components for edit → exact preview → separate approve-PR → manual merge → canonical live verification; implement only after coordinated integration |
| Legal / branding | `GET /privacy`, `GET /terms`, `GET /logo.png` | Preserve legal copy, privacy links, existing product logo and meaningful accessibility |

**Do not embed the exact website preview in an iframe** without changing the architecture; `/site-preview` is intentionally served with `frame-ancestors 'none'` and strong read-only CSP. A clear "View exact preview in a new tab" link is safe. A decorative illustration is **not** a substitute for the exact page.

**Do not redesign the GitHub or Cloudflare provider consent screens**: they are provider-hosted. Only build the Launch & Own UI around those redirects.

## Visual direction and interaction design

Choose a distinctive but restrained visual identity: friendly premium self-service SaaS, human rather than enterprise-admin. Build around the existing `/logo.png` and the product's three-part promise. Suggested aesthetic: warm near-white surfaces, ink/navy text, a confident blue primary action, softer teal/green confirmed states, restrained amber for warnings, simple illustrations of an owned site moving from idea → preview → public website. Use carefully chosen system font stacks; do not require external fonts or image CDNs.

- A consistent design token system: background, card, border, heading/body/muted text, links, success, warning, error, focus and spacing. Avoid decoration that hides critical status.
- Responsive single-column mobile flow (360–390px) and a roomy 1280–1440px desktop layout. Use logical order and avoid horizontal scroll.
- Plain-language step labels such as **Connect → Create → Preview → Approve → Launch**. Progress should reflect actual session and job states; it must not imply that consent equals publication.
- Inputs with explicit labels, examples, optional/required clarity, error explanations and visible keyboard focus. Use 44px-class touch targets, strong contrast, sufficient line-height, keyboard-friendly controls and `prefers-reduced-motion`.
- Distinguish the **private repository** (customer-owned source), **public website** (Cloudflare Pages) and **Launch & Own** (orchestrator). Customers should understand which platform is responsible for which action.
- "Review before approving" is a **design invariant**. Make preview and approval feel like two different decisions. Do not introduce a single-click connection/launch shortcut.
- Offer meaningful empty, loading, queued, pending, paused, failed, verified-live and signed-out states. Avoid cosmetic fake statuses, loading animations with no observed request, and claims of zero cost forever.
- Preserve consent and data privacy boundaries in screenshots or design examples: fictional site copy and non-real account identifiers only.

## Engineering and security constraints (non-negotiable)

1. Keep same URLs, POST actions, form field names and hidden CSRF tokens; preserve OAuth state/PKCE, login cookies, selected account, approval digest, sessions, provider scopes and ownership checks. **Don't modify `pipeline/` provisioner logic or `onboarding/run-launch-jobs.mjs`** for a visual redesign.
2. Preserve `x-frame-options`, referrer-policy `same-origin` on forms, `cache-control`, CSP, escaping, safe links and error handling. Do not introduce remote scripts, hosted CSS, trackers, unsafe inline JavaScript or third-party form submissions.
3. Do not add React/Next.js or expensive dependencies just to style a small Worker. A clean CSS module / HTML-rendering helper is fine if the current Worker bundle and tests still work; use `style-src 'unsafe-inline'` as already allowed or propose a reviewed local-only asset strategy.
4. Any theme previews in the editor must be truthful. The homepage is rendered by `site/render-site.mjs` and its allowed theme values; preserve the renderer and its exact SHA bytes. DO NOT recompute or cosmetically alter the reviewed HTML after the digest is approved.
5. Do not alter D1 schemas, secrets, GitHub App/Cloudflare OAuth permissions, zone/DNS, Worker production deployment or customer resources. Provider state changes are owned by Domain; launch runtime and retry logic are owned by Backend QA/Codex.
6. Work independently from active [#21 QA](https://github.com/mitchelldawkinsjr/launch-and-own/issues/21), [draft #31 maintenance flow](https://github.com/mitchelldawkinsjr/launch-and-own/pull/31), and [ZIP import #40](https://github.com/mitchelldawkinsjr/launch-and-own/pull/40). The UX branch must **not** be merged or deployed to the live Worker until the coordination hub authorizes a release window.

## Deliverables and acceptance

1. **Audit and design map:** list every existing screen and the current pain points. Show the proposed order, design tokens, component inventory and example customer copy in the PR.
2. **High-fidelity responsive implementation:** functional HTML/CSS in an isolated feature branch and a PR. Screens should be visually consistent and clearly branded. Do not stop at Figma/mockups.
3. **Screenshot evidence:** before/after for welcome, connected accounts, editor, resource approval, queued/building, `needs_reauthorization`, `live`, history, and representative error states; desktop ~1440px and mobile ~375px. Use mocked/sanitized data and no private cookies, codes or emails.
4. **Accessibility review:** semantic headings, form labels, live regions/alerts, focus and hover states, contrast checks, zoom/responsive checks, reduced-motion behavior and keyboard-only walkthrough.
5. **Regression proof:** run `npm test`, `npm run preflight:onboarding`, and `node --check onboarding/worker.mjs`. Add/update tests to assert expected visible workflow text and that CSRF tokens, exact POST targets, status representations, preview links, and security headers remain unchanged.
6. **Handoff:** summarize what the PR changes, file list, screenshots, remaining live-only manual checks and the specific QA/Domain approval needed before any Worker deployment.

## Definition of done

A nontechnical beta tester can tell **what to do now**, **what will happen if they approve**, **which services they own**, and **whether their site is actually live**, on phone or desktop. Tests pass and no security or provider semantics changed. The PR is ready for review; it is **not a live production release** until #21 + Domain explicitly clear it.

**Design & implementation owner:** UI/UX agent working on [Issue #41](https://github.com/mitchelldawkinsjr/launch-and-own/issues/41). Post branch name and screenshots there, keep central coordination on #2.
