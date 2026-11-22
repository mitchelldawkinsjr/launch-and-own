# Packaging the Launch & Own portable skill

Canonical source of truth: this directory (`skills/launch-and-own/`), versioned with the repository.

## Cursor / Codex / Claude Code (instructions-only)

| Client | Suggested install |
| --- | --- |
| Cursor project skill | Copy or symlink `skills/launch-and-own` → `.cursor/skills/launch-and-own` in a checkout (do not edit Cursor’s reserved `~/.cursor/skills-cursor/`). |
| Claude Code / Agent Skills | Point the client at this folder’s `SKILL.md` using that client’s documented skill import path. |
| Codex | Load `SKILL.md` (+ `reference.md` / `examples.md` as needed) as project instructions; do not invent undocumented tool schemas. |

Keep wrappers **thin**: same markdown, no duplicated provisioning logic.

## Claude plugin wrapper (thin)

Until a supported Claude connector + shared MCP (#43) ships:

1. Ship this skill as the plugin’s instruction/skill payload.
2. Do **not** invent Claude tool names that call GitHub/Cloudflare or invent publish endpoints.
3. Optional future: map #43 MCP tools 1:1 once the backend contract exists — same approval rules.

A stub manifest is intentionally **not** published here to avoid implying a store listing. Create vendor manifests only with explicit owner approval.

## ChatGPT packaging

Owned with the shared API in [#43](https://github.com/mitchelldawkinsjr/launch-and-own/issues/43). The existing private `elite-site-pipeline` skills-only plugin is **not** a production tool-backed publisher. Do not claim it launches sites via Launch & Own APIs.

## Compatibility limits

- This skill alone cannot complete OAuth, create repos, or verify live SHA+HTML.
- Browser handoff URL must remain `https://onboard.360web.cloud` unless Domain changes the approved origin.
- No platform publication, marketplace listing, or OAuth permission expansion without owner authorization.
