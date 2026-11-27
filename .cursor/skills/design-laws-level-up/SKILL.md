---
name: design-laws-level-up
description: >-
  Runs a design level-up pass through 20 UX laws (aesthetic-usability, proximity,
  Von Restorff, Zeigarnik, Tesler, Prägnanz, serial position, progressive disclosure,
  common region, goal-gradient, similarity, recognition over recall, Pareto, Occam,
  Parkinson, uniform connectedness, paradox of the active user, cognitive load,
  default effect, peak-end) and then edits the UI so Launch & Own onboarding surfaces
  fit those rules. Use when the user asks for a design laws pass, UX laws audit,
  level-up pass, laws of UX review, or to improve toolkit / site-options / update
  pipeline / approval UI through those principles.
---

# Design laws level-up

Audit the target UI through the 20 laws, then **make concrete UI/UX changes** so the surfaces fit. Do not stop at critique.

Default scope (unless the user names otherwise): onboarding **toolkit**, **optional features** (`/site-options`), **update pipeline** (editor / review / status), and **approval gates**.

Full law definitions and Launch & Own applications: [laws.md](laws.md). Read that file before scoring.

## Hard constraints (never violate)

- Preserve **Describe it. Launch it. Own it.** and owner approval / no second publishing stack.
- Stay **CSP-safe**: no remote fonts, scripts, or Material icons.
- Do **not** ship Stitch fiction (Deploy All, fake DNS tables, dark nav chrome the product does not have).
- Prefer the existing Stitch / Warm Self-Service tokens when present (`onboarding/design/stitch-tokens.css.mjs`, `onboarding/ui.mjs`).
- Product chrome is **Operate** mode: clarity and ownership cues over marketing expression.
- Do not weaken fail-closed ownership, digests, or tenant checks for polish.

## Workflow

Copy and track:

```
Laws pass:
- [ ] 1. Scope surfaces + open laws.md
- [ ] 2. Inspect current UI (markup/CSS + rendered evidence if available)
- [ ] 3. Score all 20 laws
- [ ] 4. Pick a small high-impact fix set
- [ ] 5. Implement changes
- [ ] 6. Verify (tests / walkthrough)
- [ ] 7. Report
```

### 1. Scope

Name the routes/files. Typical map:

| Surface | Likely files |
|---|---|
| Toolkit | `onboarding/post-launch-toolkit.mjs`, stitch tokens |
| Options | `onboarding/post-launch-options.mjs` |
| Update flow | `onboarding/site-update-flow.mjs`, `renderUpdateStatusBody` |
| Shell | `onboarding/ui.mjs`, `onboarding/worker.mjs` |

If the user names one screen, stay there. If they say “the app,” cover the default scope above.

### 2. Inspect

- Read the markup/CSS for scoped surfaces.
- If `npm run visual:walkthrough` or `visual-walkthrough/` shots exist, use them as evidence.
- Note primary CTAs, open loops, collapsed complexity, first/last content, and defaults.

### 3. Score every law

For each of the 20 laws in [laws.md](laws.md), record:

| # | Law | Verdict | Evidence | Fix if failing |
|---|---|---|---|---|
| n | name | pass / fail / n/a | short | one concrete change |

Verdicts:

- **pass** — clearly fits the law’s Launch & Own application
- **fail** — violates or weakly supports it; needs a change
- **n/a** — surface does not involve that law (say why)

### 4. Prioritize (Pareto + Occam)

Implement a **small** set that moves the needle:

1. Failures that hide the owner’s real decision (Von Restorff, cognitive load, defaults)
2. Failures that strand open work (Zeigarnik, goal-gradient, peak-end)
3. Failures that break grouping / scan (proximity, common region, similarity, Prägnanz)
4. Polish (aesthetic-usability, serial position, Parkinson)

Skip nice-to-haves that add chrome without helping ownership. Prefer one honest CTA over decorative complexity.

### 5. Implement

Edit markup/CSS/copy so failing laws become passes. Typical levers:

- Group related facts; one primary button; secondary as `btn-secondary`
- Open-loop status (“awaiting merge”, “stored — not on”)
- Decisions first; digests/SHAs in `<details>`
- Tabs / phases / collapsed tech (progressive disclosure)
- Pipe Done/Now tags; strong end state (“live and checked”)
- In-UI callouts for merge authority and “nothing live until you turn it on”
- Cap hero/section copy; one job per section

Do not invent features, provider actions, or publishing paths.

### 6. Verify

- Run focused tests for touched flows; prefer `npm test` when changes span onboarding.
- If visual walkthrough exists: `npm run visual:walkthrough` (add `--open` only if the user asked to view).
- Re-score only the laws you claimed to fix; leave no known fail you marked as in-scope.

### 7. Report

Keep it short:

1. Surfaces touched
2. Laws fixed (number + name + what changed)
3. Laws still failing / deferred (with why)
4. How you verified

## Anti-patterns

- Critique-only replies with no code changes (unless the user asked audit-only)
- Redesigning marketing landing when the ask was product chrome
- Adding Google Fonts, icon CDNs, or Stitch-only fiction
- Multiple competing primary CTAs on one view
- Expanding options into a second product (Parkinson)
- Defaulting owners into live DNS / MX / beacon changes
