# Packaging the Launch & Own portable skill

Canonical source of truth: this directory (`skills/launch-and-own/`), versioned with the repository.

## Cursor / Codex / Claude Code (instructions-only)

| Client | Suggested install |
| --- | --- |
| Cursor project skill | Copy or symlink `skills/launch-and-own` → `.cursor/skills/launch-and-own` in a checkout (do not edit Cursor’s reserved `~/.cursor/skills-cursor/`). |
| Claude Code / Agent Skills | Prefer the thin plugin at [`clients/claude-plugin/`](../../clients/claude-plugin/) (`claude --plugin-dir ./clients/claude-plugin`), or point the client at this folder’s `SKILL.md`. |
| Codex | Load `SKILL.md` (+ `reference.md` / `examples.md` as needed) as project instructions; do not invent undocumented tool schemas. |

Keep wrappers **thin**: same markdown, no duplicated provisioning logic. After editing this skill, run `npm run sync:claude-plugin` so the Claude plugin copy stays identical.

## Claude plugin wrapper (thin)

Repo path: [`clients/claude-plugin/`](../../clients/claude-plugin/).

Until a supported Claude connector + shared MCP (#43) ships:

1. Ship this skill as the plugin’s instruction/skill payload (synced copies of `SKILL.md`, `reference.md`, `examples.md`).
2. Do **not** invent Claude tool names that call GitHub/Cloudflare or invent publish endpoints.
3. Do **not** add `mcpServers`, hooks that publish, or marketplace/directory submission without explicit owner approval.
4. Optional future: map #43 MCP tools 1:1 once the backend contract exists — same approval rules.

Local load via `--plugin-dir` is supported for developers and beta testers. A public marketplace or Anthropic directory listing is **not** authorized by shipping this wrapper.

## ChatGPT packaging

Owned with the shared API in [#43](https://github.com/mitchelldawkinsjr/launch-and-own/issues/43). The existing private `elite-site-pipeline` skills-only plugin is **not** a production tool-backed publisher. Do not claim it launches sites via Launch & Own APIs.

## Compatibility limits

- This skill alone cannot complete OAuth, create repos, or verify live SHA+HTML.
- Browser handoff URL must remain `https://onboard.360web.cloud` unless Domain changes the approved origin.
- No platform publication, marketplace listing, or OAuth permission expansion without owner authorization.
