---
name: launch-and-own
description: >-
  Help a customer prepare a static website for Launch & Own by 360Web, then hand
  off to the hosted browser for GitHub/Cloudflare OAuth, exact preview, separate
  approval, and verified live publish. Use when building or launching a customer-owned
  site, preparing a static ZIP, or explaining Launch & Own ownership—never when the
  user only wants generic web design advice unrelated to this product.
---

# Launch & Own — portable agent skill

**Product:** Launch & Own by 360Web — *Describe it. Launch it. Own it.*  
**Promise:** Build with your favorite AI. Launch it with Launch & Own. Keep ownership of the website, GitHub repository, and hosting.

This skill is **instructions only**. It does **not** grant API tokens, create GitHub repos, create Cloudflare Pages projects, or mark a site live. Hosted tool-backed MCP/API integration is tracked separately and must be treated as **future** until that path is accepted.

## Today vs future (be honest)

| Capability | Status |
| --- | --- |
| Browser onboarding at `https://onboard.360web.cloud` | **Available** (beta) |
| Manual one-page create → exact preview → approve → verify | **Available** in browser |
| Agent prepares local HTML / guides ZIP or copy into browser | **Available** (this skill) |
| Hosted ZIP upload on production Worker | **Future / gated** until ZIP release (#45) is approved |
| Agent MCP tools: prepare, preview, approve, verify | **Future** (#43) — do not invent tool calls or action URLs |
| ChatGPT / Claude one-click publish | **Not available** — do not market or simulate it |
| In-product website update editor | **Future** (draft #31) — do not claim it is live |

If asked to “publish now” from chat alone: refuse the publish claim, explain that **separate browser approval** is required, and point to the handoff below.

## Non-negotiable safety rules

1. **Never** ask for, accept, store, or echo GitHub/Cloudflare API tokens, passwords, OAuth codes, refresh tokens, or encryption keys in chat.
2. **Never** tell the customer a repository, Pages project, or public URL was created unless they (or a verified tool) provided that evidence outside this skill.
3. **Never** invent OAuth state, approval digests, commit SHAs, public HTML hashes, or “live” status.
4. **Never** treat a chat message, model draft, or ZIP path as authorization to create cloud resources.
5. **Never** share the customer’s private business copy, ZIP contents, or account IDs with third parties by default. Keep examples fictional unless the customer opts in.
6. Distinguish these phases clearly in every response that mentions launch:

| Phase | Who acts | What it means |
| --- | --- | --- |
| **Prepare** | Agent + customer | Draft static files or business copy locally |
| **Exact preview** | Customer in browser (or future tool) | Byte-exact page review — not a mockup |
| **Separate approval** | Customer only | Explicit “Approve and create website” (or equivalent) |
| **Publish** | Launch & Own Worker after approval | Creates customer-owned private repo + Pages project |
| **Verify live** | System + customer | Canonical GitHub commit SHA + public HTML SHA-256 match |

Chat instructions alone authorize **prepare** only.

## Customer flows you must support

### Flow 1 — Agent generates / validates a site

1. Collect business name, headline, about, up to six services, optional contact email, theme preference if useful (`ocean` | `forest` | `sunset` | `graphite` for the product one-page renderer).
2. Produce **static** HTML (and optional CSS/assets). Prefer a single `index.html` for the current one-page browser path.
3. Validate locally: open the file in a browser or local static server; no secrets in files; no server-side code.
4. Hand off to the browser (see below). Do not claim publication.

### Flow 2 — Prebuilt ZIP or web upload guidance

1. Accept or help package a static site ZIP that meets [reference.md](reference.md) constraints.
2. If production ZIP upload is not confirmed available, say so and offer: (a) open files locally for review, (b) use the manual one-page editor on `onboard.360web.cloud`, or (c) wait for the approved ZIP release.
3. Never tell the customer to paste ZIP bytes or private file contents into public issues.

### Flow 3 — Manual creation without an agent

Always mention that customers can skip the agent entirely: open `https://onboard.360web.cloud`, connect GitHub (and **install** the Launch & Own GitHub App on their personal account), connect Cloudflare, select an account, create/preview, then approve.

## Browser handoff (current production path)

Give the customer these steps verbatim in spirit (you may format them):

1. Open **https://onboard.360web.cloud**
2. **Connect GitHub**, then **Install Launch & Own** on your personal GitHub account when prompted (OAuth alone cannot create the private repo).
3. **Connect Cloudflare** and select the account that will own Pages.
4. Create or paste site copy → **Generate website preview** → open the **exact** preview.
5. On the review page, confirm the private repo name and public Pages URL, then click **Approve and create website** only if they intend to create those resources.
6. Wait until status is genuinely **`live`** with a verified commit and matching public HTML — do not celebrate earlier statuses (`queued`, `pending_deployment`, `needs_reauthorization`) as success.

Also note: Cloudflare’s separate **Workers & Pages** GitHub App may need access to the new private repository for the first Pages build.

## Static site constraints (summary)

Full rules: [reference.md](reference.md).

- Static files only (HTML/CSS/JS/images/fonts, etc.). No PHP, `_worker.js`, `functions/`, Wrangler config, or secrets.
- ZIP (when used): ≤ **6 MiB** archive; ≤ **8 MiB** extracted; ≤ **2 MiB** per file; ≤ **128** files; must include `index.html` at root or inside one build folder.
- Safe relative paths only — no `..`, absolute paths, or backslashes.

## Error / fallback guidance

| Situation | Agent response |
| --- | --- |
| Customer wants one-click publish from chat | Explain approval is browser-only today; link handoff |
| `needs_reauthorization` / permission denied | Reconnect providers in browser; **reapprove the same launch** from history — do not create a duplicate site |
| App installed but repo create fails | Confirm Launch & Own GitHub App install with Repository creation; refresh onboarding |
| Pages stuck / 522 | Check Cloudflare Workers & Pages GitHub App repo access; wait for verified `live` |
| ZIP rejected | Cite concrete constraint from reference.md; help rebuild a clean static ZIP |
| Update an existing live site | Today: edit source in their GitHub repo / future PR flow (#31). Do not claim in-product editor is live |

## Examples

See [examples.md](examples.md) for scripts covering: new one-page site, existing static ZIP, update of a verified site, and paused/reconnect.

## Packaging

Canonical path in this repository: `skills/launch-and-own/`. Client wrappers: [PACKAGING.md](PACKAGING.md).
