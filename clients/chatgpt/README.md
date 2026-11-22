# Launch & Own — ChatGPT packaging notes (thin)

**Status:** planning / instructions only. **Not** a ChatGPT store listing, GPT Action deployment, or connected publishing connector.

ChatGPT must use the **same** shared MCP/API contract as Claude (`integration/` + [#43](https://github.com/mitchelldawkinsjr/launch-and-own/issues/43)). Do not fork a second GitHub/Cloudflare provisioning stack.

## Today

- Portable skill: [`skills/launch-and-own/`](../../skills/launch-and-own/) (browser handoff to https://onboard.360web.cloud).
- Existing private `elite-site-pipeline` plugin is **skills-only** — not a Launch & Own tool-backed publisher.
- Shared bridge modules exist in-repo as an **undeployed** prototype (`integration/bridge-worker.mjs`). Domain approval, OAuth resource registration, and D1 persistence are required before any connected client claim.

## Not allowed until accepted

- Marketplace / GPT store publication
- Invented Action schemas that call GitHub or Cloudflare directly
- One-click publish from chat
- Advertising connected Launch & Own tools in ChatGPT

## Future (after #43 Worker + independent QA)

1. Register the same protected resource / audience as the Claude bridge.
2. Map the ten contract tools 1:1 — no ChatGPT-only publish shortcut.
3. Keep human approval on the hosted browser review page.
4. Promote `chatgpt_connector` in `distribution/release-matrix.json` only after orchestration review.
