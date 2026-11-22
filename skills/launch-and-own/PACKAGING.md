# Packaging the Launch & Own portable skill

Canonical source of truth: this directory (`skills/launch-and-own/`), versioned with the repository.

## Cursor / Codex / Claude Code (instructions-only)

| Client | Suggested install |
| --- | --- |
| Codex project skill | From this checkout: `node scripts/install-agent-skill.mjs --client codex --target /path/to/project`. Installs canonical files into `.agents/skills/launch-and-own/`. |
| Cursor project skill | From this checkout: `node scripts/install-agent-skill.mjs --client cursor --target /path/to/project`. Installs canonical files into `.cursor/skills/launch-and-own/`. Never edit Cursor's reserved `~/.cursor/skills-cursor/`. |
| Claude Code / Agent Skills | Point the client at this folder's `SKILL.md` using its documented import path. Claude plugin packaging is owned by a separate branch. |

Run the installer with `--dry-run` to see the destination without writing or `--check` to verify byte-for-byte content and a SHA-256 bundle. It refuses to overwrite local edits or follow symlinked install directories. It copies public skill instructions only, with no API credentials or cloud operations.

Follow [INSTALL_QA.md](INSTALL_QA.md) for manual testing in *real* Codex and Cursor sessions. Automated installer tests establish safe layout and file integrity only: they are **not** an actual model or connected publishing acceptance test.

Keep wrappers **thin**: the same canonical markdown, no duplicated provisioning logic.

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
