# Agent distribution and release contract

**Orchestration owner:** [Issue #55](https://github.com/mitchelldawkinsjr/launch-and-own/issues/55). **MCP/API backend owner:** [Issue #43](https://github.com/mitchelldawkinsjr/launch-and-own/issues/43). **Cross-agent coordination:** [Issue #2](https://github.com/mitchelldawkinsjr/launch-and-own/issues/2).

## Product positioning and current truth

**Build with your favorite AI. Launch with Launch & Own. Keep ownership of everything.**

Launch & Own is a free-to-use beta publishing workflow, **not a guarantee of free provider services or unlimited AI inference**. Customers own their GitHub source and Cloudflare hosting. They review and separately approve the exact prepared site before resources are created.

**Today:** https://onboard.360web.cloud supports a hosted browser manual one-page beta. The owner-account B13 launch reached live with an approved GitHub commit and matching public HTML SHA-256 ([evidence #21](https://github.com/mitchelldawkinsjr/launch-and-own/issues/21#issuecomment-7086107082)). **An independent consenting customer's launch and approved post-launch edit are still outstanding**.

**Portable instructions are available:** [the Launch & Own skill](../skills/launch-and-own/SKILL.md) is merged and CI-tested ([#56](https://github.com/mitchelldawkinsjr/launch-and-own/pull/56)). It can guide preparation and browser handoff, **but does not connect to or publish through GitHub/Cloudflare APIs**. A thin Claude Code plugin wrapper under `clients/claude-plugin/` packages that same skill for local `--plugin-dir` load only — **not** a store listing or connected publisher ([#60](https://github.com/mitchelldawkinsjr/launch-and-own/pull/60)).

**Not live:** ZIP import code is merged, but hosted uploads require approved R2 activation/private bucket, isolated preview origin and live acceptance ([#45](https://github.com/mitchelldawkinsjr/launch-and-own/issues/45)). Draft [editor #31](https://github.com/mitchelldawkinsjr/launch-and-own/pull/31) is not released. The existing private ChatGPT elite-site-pipeline plugin is **skills-only**, not an authenticated Launch & Own tool connection. Connected Claude/ChatGPT publishing tools remain planned until the shared MCP/API ([#43](https://github.com/mitchelldawkinsjr/launch-and-own/issues/43)) is deployed and accepted.

## One shared capability status matrix

The authored status source is [distribution/release-matrix.json](../distribution/release-matrix.json). The checker is [distribution/release-gates.mjs](../distribution/release-gates.mjs).

Run **npm run qa:distribution** to show and validate the capability matrix, or **npm test** for the complete regression suite. Both run in CI.

Every entry-point status has three separate dimensions:

- **Code:** planned → in_pr → merged → deployed. Merged code does not mean enabled hosting or approved distribution.
- **Access:** not_available → hosted_beta → external_beta → public for hosted/connected tools. A separately reviewed and tested portable skill may use **instructions_only** once its code is merged, without suggesting connected publishing. Hosted beta requires real owner-account live evidence; external beta needs a **separately consenting independent** customer; public also requires recorded explicit owner release authorization.
- **Verification:** not_tested → ci_only → owner_live → independent_live. Workerd simulations are necessary regression evidence, but they do not prove provider-backed launch or customer acceptance.

Example: browser ZIP may correctly show **merged / not_available / ci_only** while its private storage and production preview aren't ready. A portable skill may be distributed as **instructions only**; it must never imply connected publishing tools that do not exist. A Claude or ChatGPT connected client cannot be promoted until the **same shared MCP/API backend** is deployed and accessible.

**Limit of automation:** The checker validates status consistency and the *format* of evidence URLs. GitHub links are pointers for **human review**, not proof that an external account, consent, live website or distribution approval occurred. The reviewer must examine real dated evidence before promoting a stage. Keep claims conservative when evidence is incomplete.

## Exact release gate for each client

1. Code reviewed, regression tests and independent Worker tests green, and client install/tool-contract compatibility verified. Store only nonsecret links and redacted evidence in issues and PRs.
2. Server verifies customer identity, GitHub App **installation** as well as OAuth authorization, and the selected Cloudflare account. The agent never sees OAuth secrets, provider tokens or owner session material.
3. The customer inspects the **exact immutable HTML or bundle artifact**, target GitHub repository, Pages project and relevant costs/quotas; not an inspirational or approximate design mockup.
4. The owner **separately approves** the artifact and resource changes through a server-verified, tenant-bound action. A chat message or agent invocation is not a substitute for explicit consent. Updates go through reviewed GitHub PRs, not silent main-branch changes.
5. Durable job and any reauthorization steps are observable. Only report **live** after checking canonical production GitHub commit and public HTML digest against the approved revision. Pause/retry must not duplicate resources or use stale authorization.
6. For **external beta**, capture one new independent consenting user **per** connected client, including negative permission/reconnect tests and nonsecret commit/digest evidence. For **public**, record the owner's explicit platform distribution approval with a specific evidence link.
7. Domain/OAuth operator reviews and authorizes any Worker/DNS/provider settings changes, compatible rollout and rollback. Never deploy ZIP-enabled main to a deliberately pre-ZIP production Worker as a shortcut.

## Workstream ownership and integration boundaries

| Stream | Owns | Boundary |
| --- | --- | --- |
| **Orchestration / integration QA** | Release matrix, evidence review, CI gates, truthful customer claims | This document, distribution scripts, [#55](https://github.com/mitchelldawkinsjr/launch-and-own/issues/55); **no** production provider actions |
| **Portable skill author** | Versioned reusable Agent Skill, examples, supported clients, safe browser handoff | Suggested skills/launch-and-own; post PR in #55. Skill is **instructions**, not an API implementation |
| **Shared MCP/API agent** | Tenant-bound account linking, prepared artifacts, exact previews, approval handoff, job status and verification | [#43](https://github.com/mitchelldawkinsjr/launch-and-own/issues/43); no separate GitHub/Cloudflare stacks for different AI clients |
| **Client-wrapper authors** | Thin Claude and ChatGPT packaging and separately verified installs | Use the **same MCP/API**; no automatic or unaudited publishing |
| **Domain/OAuth/QA** | Live Worker, permissions, TLS, R2 rollout, independent acceptance | [#2](https://github.com/mitchelldawkinsjr/launch-and-own/issues/2), [#21](https://github.com/mitchelldawkinsjr/launch-and-own/issues/21), [#45](https://github.com/mitchelldawkinsjr/launch-and-own/issues/45) |
| **Standalone UI/UX** | Browser manual/ZIP onboarding | Draft [#53](https://github.com/mitchelldawkinsjr/launch-and-own/pull/53) and [#31](https://github.com/mitchelldawkinsjr/launch-and-own/pull/31) both edit onboarding/worker.mjs; coordinate before merging |

Agents should claim their own issue and branch, provide nonsecret PR/QA evidence, and **request orchestration review before changing distribution/release-matrix.json**. Keep outstanding work as specific blockers. Never mark "public" or "independent_live" solely because an agent or CI reports success.

## Customer language

**Now:** "Try our free Launch & Own browser beta to prepare, preview and approve a simple website on accounts you own. Hosted ZIP uploads and connected AI-agent publication are not yet available."

**After connected-client QA:** "Build with ChatGPT, Claude or a compatible agent. Review the exact site, approve publication and keep the code and hosting in your own accounts."

360Web attribution may demonstrate engineering capability but should never obligate free customers to buy automation, install unrelated services, or share their private content.
