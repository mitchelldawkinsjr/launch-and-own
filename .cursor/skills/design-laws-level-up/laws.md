# Design laws — definitions and Launch & Own applications

Use this file when scoring. Keep definitions and applications **verbatim** below.

Surfaces in scope unless the user narrows: toolkit, optional features, update pipeline, approval gates.

---

I'll map each law to Launch & Own's onboarding surfaces—toolkit, options, and the update pipeline.

Here’s each law in plain terms, then how it can tighten Launch & Own’s UI/UX (toolkit, optional features, update pipeline, approval gates).

1. Aesthetic-usability effect

People trust and tolerate polished UI more. Keep the Warm Self-Service look consistent so ownership screens feel safe, not like an admin console.

2. Law of proximity

Items near each other feel related. Group “Public web” with verification, and GitHub with Cloudflare, so status and infra don’t float as disconnected facts.

3. Von Restorff effect

What’s different gets noticed. Make one primary action stand out (Approve and publish, Turn on, Open PR)—everything else secondary so the owner’s real decision is obvious.

4. Zeigarnik effect

Open loops stick in memory. Show incomplete pipelines (PR awaiting merge, stored but not turned on) as clear “still open” states so people finish the ownership steps.

5. Tesler’s law

Complexity can’t vanish; you choose who holds it. Keep digests, SHAs, and provider details behind details/expanders; put decisions (approve, merge, turn on) in the open.

6. Law of Prägnanz

Minds prefer the simplest clear shape. Prefer one stacked composition per screen over dense dashboards so “Describe → Launch → Own” reads as a single story.

7. Serial position effect

First and last items stick. Lead with brand + site name; end each flow with a strong close (live and checked, back to toolkit)—don’t bury the outcome in the middle.

8. Progressive disclosure

Show only what’s needed now. Phase A vs Phase B on options, tabs on toolkit, technical details collapsed—reveal edge/runtime risk only when relevant.

9. Law of common region

Shared borders/backgrounds signal a group. Keep using cards/blocks for dual status, pipe steps, and option modules so each “unit of work” is visually one region.

10. Goal-gradient effect

Motivation rises near the finish. Make the 4-step publish pipe feel almost done when merge/check is next (Done/Now tags, progress fill) so owners complete merge/verify.

11. Law of similarity

Same style = same kind. Shared badges (GitHub / Cloudflare / Launch & Own), pills, and button hierarchy so “safe staged” vs “edge change” is learnable at a glance.

12. Recognition over recall

Don’t make people remember codes. Surface site name, pages.dev as evidence text, PR #, and stored fingerprints in context instead of asking them to recall hashes.

13. Pareto principle

~20% of actions do ~80% of the work. Optimize the few paths that matter: connect → approve → launch → toolkit → edit/update → optional turn-ons; de-emphasize rare operator tools.

14. Occam’s razor

Simplest workable UI wins. Skip Stitch fiction (Deploy All, fake DNS tables, Material chrome under CSP); one honest CTA beats decorative complexity.

15. Parkinson’s law

Work expands to fill the space. Cap hero copy, one job per section, short supporting lines—don’t let optional-features pages sprawl into a second product.

16. Uniform connectedness

Linked elements feel like one unit. Connect pipe steps, checklist rows, and PR + ownership split with lines/shared containers so the publish path feels continuous.

17. Paradox of the active user

People skip manuals and click. Put guidance in the UI (callouts on merge authority, “nothing live until you turn it on”) instead of relying on docs they’ll ignore.

18. Cognitive load

Working memory is tiny. One decision per view; don’t mix edit, options, and deploy status. Offload facts into stats/KV rows instead of paragraph walls.

19. Default effect

Defaults get chosen. Safe defaults: staged options off, PR path available, preview builds policy clear—never default into live DNS/MX/beacon changes.

20. Peak-end rule

People remember the high point and the ending. Make “live and checked” / ownership confirmation the emotional peak and end of launch and update flows—that’s what they’ll recall about Launch & Own.
