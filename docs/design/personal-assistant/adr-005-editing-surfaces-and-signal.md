# ADR-005: Where owners edit, and what Launch & Own may see

- **Status:** Proposed, 2026-11-27. It needs the owner's acceptance, recorded the same way as ADR-004. The opt-in signal in tier 3 also needs a Domain/OAuth review before anyone builds it.
- **Relates to:** #165, ADR-001 (customer-run deploy), ADR-002 (per-customer GitHub App), ADR-004 (the update channel reads GitHub, not Launch & Own)
- **Date:** 2026-11-27 · Claude Opus 5.5

## Context
Editing can happen on onboard (the hosted toolkit) or in the customer-owned assistant. Hosted editing gives Launch & Own usage signal as a side effect. The assistant gives none, because Launch & Own holds no credential and isn't in its runtime. Forcing edits through onboard to keep that signal would turn "Own it" into hosted lock-in.

## Decision
Three tiers. One shared editing library (WS2/WS3 plus `onboarding/visual-editor.mjs` and the vendored site editor), relocated, never forked.

| Tier | Where edits happen | What Launch & Own sees |
| --- | --- | --- |
| 1. Hosted toolkit (default) | onboard, after launch | The funnel and session signal it already gets |
| 2. Customer-owned assistant | the customer's Worker, behind Cloudflare Access | Nothing by default. The update check reads public GitHub releases (ADR-004 B), not Launch & Own. |
| 3. Opt-in "publish happened" count (later) | sent from the assistant only after an explicit, revocable owner opt-in | A bare count with a coarse timestamp and version. No content, URLs, repo names or identities. |

Rules:
1. **Never force tier 1.** Once an owner has an assistant, onboard can link to it but can't require edits to go through onboard.
2. **Editor parity.** Before the assistant is described as a replacement for hosted editing, a hosted-bootstrapped assistant must get the same visual canvas (`ASSETS` binding with the vendored site editor, uploaded by `assistant/setup/static-assets.mjs`). Until then the docs and UI must say the canvas is missing.
3. **Tier 3 is off until reviewed.** It needs a consent screen, a setting to turn it off, a documented payload, and a Domain/OAuth review. Owner-only live evidence isn't customer acceptance.
4. **The business case doesn't depend on hosted editing.** Revenue and engagement come from launch, optional features (forms, domain, analytics), assistant template releases and support. None of these need Launch & Own in the edit path.

## Consequences
- Marketing copy says owners can keep editing in the toolkit or move to their assistant, and that Launch & Own wouldn't track assistant use. The assistant stays "planned" until the release matrix says otherwise.
- The site editor still loads CodeMirror, diff, isomorphic-git (esm.sh, pinned versions) and lucide (`unpkg.com/lucide@latest`, **unpinned**) from third-party CDNs inside owner-only admin pages. That has to be fixed by vendoring or pinning with integrity checks before the assistant canvas counts as accepted. It's tracked as a follow-up and isn't solved by this ADR.

## Rejected
- **Hosted-only editing:** breaks the ownership promise and the design in #170.
- **Implied telemetry from the assistant** (an update check that phones Launch & Own, or GitHub App webhooks to Launch & Own): it's a hidden signal without consent and conflicts with "no durable credential".
