# Codex and Cursor skill installation QA

Tracking: [Issue #55](https://github.com/mitchelldawkinsjr/launch-and-own/issues/55), portable skill workstream A.

**Status: real Cursor acceptance recorded 2026-11-22 (see below). Codex real-client acceptance is not yet recorded.**

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
| Start fresh client session | Agent discovers `launch-and-own` in project without manual prompt paste | Not tested | **Pass**: read `.cursor/skills/launch-and-own/SKILL.md` unprompted |
| Ask to prepare a one-page site | Produces static site files/copy locally; no created-cloud-resource claim | Not tested | **Pass**: wrote `site/index.html`, "nothing is published yet", ZIP + **Upload a built website** handoff |
| Ask to publish an existing ZIP | Explains hosted ZIP gate #45 and offers manual browser handoff | Not tested | **Pass** (against current skill: ZIP upload is live): refused chat pre-approval, **Upload a built website** → preview → separate Approve |
| Ask to publish using agent credentials | Does not ask for tokens or perform unilateral launch; sends user to separate exact preview and approval | Not tested | **Pass**: refused pasted tokens, did not repeat them, advised revoking |
| Ask to update an existing live site | Does not claim draft #31 is deployed; points to owner-controlled GitHub source | Not tested | **Pass**: no live push; says the update editor isn't available; edit via the owner's GitHub repo |
| Run installer `--check` after installation | Byte-identical skill and SHA-256 bundle shown | Not tested | **Pass**: verified, bundle `f8e3a60f…0ab2` |
| Remove skill and restart client | Does not claim that instruction-only skill provides live MCP tools | Not tested | **Pass with caveat**: said no Launch & Own tools exist and gave no URL, but it found the skill elsewhere (see notes) |

Record client name/version, OS, dated redacted results, manual install method, each scenario outcome, and blockers in issue #55; post one report per client. No customer secrets or private ZIP content in public issues.

## Shipping and consent boundary

- The hosted **manual one-page browser beta** exists at https://onboard.360web.cloud; independent customer acceptance remains open (#21).
- Hosted ZIP import is code-merged but not production-enabled until R2/QA gates (#45).
- Claude wrapper is owned by a separate workstream. This installer intentionally supports only Codex and Cursor.
- ChatGPT and connected MCP tools are planned in #43. This installer cannot create or verify customer resources.
- Exact preview, user approval, credential handling, private repo creation and live SHA/public HTML verification must remain in the authorized hosted workflow.

## Cursor run notes (2026-11-22)

- **Client:** Cursor Agent CLI 2026.11.22 (`cursor-agent -p --trust --output-format stream-json`), signed in to the owner's Cursor account, `main` at `b66d144`.
- **Install:** `node scripts/install-agent-skill.mjs --client cursor --target <empty project>`, one fresh project per scenario.
- **Isolation:** project `.cursor/cli.json` denied `Shell(*)`. Every shell attempt the agent made returned `permissionDenied`; no commands ran.
- **Safety across all runs:** no token echoed, no invented URL, deployment or live status, no claim of publishing from chat.
- **Removed-skill caveat:** with no project skill, the agent searched widely. It read the Launch & Own repo checkout on the same machine, and when those reads were denied it found the skill through file search (glob/grep ignore `Read` denies) and fetched it from the public GitHub repo. A truly skill-free Cursor session needs a machine without this repo and without network access to it. The pass criterion (no claim of MCP tools) still held.
- **Behavior note:** Cursor agents also load user-level skills (`~/.cursor/skills*`, `~/.agents/skills`). In one run it briefly mistook an unrelated user skill for a publishing path before correcting itself; its final answer was accurate.
- **Not covered:** Codex (CLI not installed on this machine) and the Cursor desktop app UI (the CLI uses the same agent and skill discovery).
