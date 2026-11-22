# Codex and Cursor skill installation QA

Tracking: [Issue #55](https://github.com/mitchelldawkinsjr/launch-and-own/issues/55), portable skill workstream A.

**Status: automated file installation checks only. Real Codex and Cursor acceptance is not yet recorded.**

## Install into an existing project

From a checkout of this repository with Node 22.5+ installed:

```sh
node scripts/install-agent-skill.mjs --client codex --target /path/to/customer-project --dry-run
node scripts/install-agent-skill.mjs --client codex --target /path/to/customer-project
node scripts/install-agent-skill.mjs --client codex --target /path/to/customer-project --check

node scripts/install-agent-skill.mjs --client cursor --target /path/to/customer-project --dry-run
node scripts/install-agent-skill.mjs --client cursor --target /path/to/customer-project
node scripts/install-agent-skill.mjs --client cursor --target /path/to/customer-project --check
```

- Codex installs to `<customer-project>/.agents/skills/launch-and-own/`.
- Cursor installs to `<customer-project>/.cursor/skills/launch-and-own/`.
- Copies only `SKILL.md`, `reference.md`, `examples.md`, `PACKAGING.md`, and `INSTALL_QA.md`: no credentials, tests, vendor manifests, MCP services or GitHub/Cloudflare mutations.
- Copies stay byte-for-byte identical to the canonical source; no custom agent prompt can bypass browser approval.
- Existing installations are verified, never overwritten. To update, review the old and new skill then explicitly remove the old copy before installing again.
- The installer rejects symlinked installation directories and does not write in `--dry-run` or `--check`.

Vendor docs: [Codex project skills](https://developers.openai.com/blog/skills-agents-sdk), [Codex customization](https://learn.chatgpt.com/docs/build-skills), [Cursor Agent Skills](https://cursor.com/docs/skills).

## Manual client acceptance (still required)

Run each step in an isolated project and a **real installed client**. Automated Node smoke checks only validate files; they cannot prove skill discovery or model behavior.

| Scenario | Expected result | Codex | Cursor |
| --- | --- | --- | --- |
| Start fresh client session | Agent discovers `launch-and-own` in project without manual prompt paste | Not tested | Not tested |
| Ask to prepare a one-page site | Produces static site files/copy locally; no created-cloud-resource claim | Not tested | Not tested |
| Ask to publish an existing ZIP | Explains hosted ZIP gate #45 and offers manual browser handoff | Not tested | Not tested |
| Ask to publish using agent credentials | Does not ask for tokens or perform unilateral launch; sends user to separate exact preview and approval | Not tested | Not tested |
| Ask to update an existing live site | Does not claim draft #31 is deployed; points to owner-controlled GitHub source | Not tested | Not tested |
| Run installer `--check` after installation | Byte-identical skill and SHA-256 bundle shown | Not tested | Not tested |
| Remove skill and restart client | Does not claim that instruction-only skill provides live MCP tools | Not tested | Not tested |

Record client name/version, OS, dated redacted results, manual install method, each scenario outcome, and blockers in issue #55; post one report per client. No customer secrets or private ZIP content in public issues.

## Shipping and consent boundary

- The hosted **manual one-page browser beta** and **static ZIP upload beta** exist at https://onboard.360web.cloud (owner-tested; independent customer acceptance remains open — #21/#45).
- Near-limit ZIP uploads can use substantial Worker CPU; do not assume Free-plan limits cover maximum archives (#45).
- Claude Code thin plugin packaging lives at `clients/claude-plugin/` (instructions-only local `--plugin-dir`). This installer intentionally supports only Codex and Cursor project paths.
- ChatGPT and connected MCP tools are planned in #43. This installer cannot create or verify customer resources.
- Exact preview, user approval, credential handling, private repo creation and live SHA/public HTML verification must remain in the authorized hosted workflow.
