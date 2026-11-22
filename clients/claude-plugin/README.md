# Launch & Own — Claude Code plugin (thin wrapper)

**Status:** instructions-only local packaging. **Not** a marketplace listing, Anthropic directory submission, or connected publishing connector.

This directory is a thin Claude Code plugin around the portable skill at [`skills/launch-and-own/`](../../skills/launch-and-own/). Skill markdown here must stay byte-identical to that canonical copy (enforced by tests; refresh with `npm run sync:claude-plugin`).

## What this plugin does

- Loads the Launch & Own skill so Claude can help **prepare** static HTML / ZIP guidance.
- Points customers to **https://onboard.360web.cloud** for GitHub/Cloudflare OAuth, exact preview, separate approval, and verified live publish.

## What this plugin does **not** do

- No MCP servers, custom tools, or invented publish endpoints.
- No GitHub or Cloudflare API calls from the plugin.
- No one-click publish from chat.
- No store / marketplace publication without separate explicit owner approval.

Connected Claude publishing tools require the shared MCP/API in [Issue #43](https://github.com/mitchelldawkinsjr/launch-and-own/issues/43). Until that ships and is accepted, treat this wrapper as **skill packaging only**.

## Local install (session)

From a checkout of this repository:

```sh
claude --plugin-dir ./clients/claude-plugin
```

Validate the layout (optional; requires Claude Code CLI):

```sh
claude plugin validate ./clients/claude-plugin
```

Use the skill for prepare/handoff work. Never paste provider tokens into chat.

## Ownership and privacy

Customers keep their own GitHub repositories and Cloudflare hosting. Agents must not claim a site is live without verified commit + public HTML evidence from the hosted flow. See [PACKAGING.md](../../skills/launch-and-own/PACKAGING.md) and [Issue #55](https://github.com/mitchelldawkinsjr/launch-and-own/issues/55).
