---
name: design-laws
description: Apply 20 UX laws when designing, changing or reviewing any Launch & Own screen (onboarding Worker pages, toolkit, editors, assistant). Use before writing UI markup or CSS, and when reviewing screenshots from `npm run visual:walkthrough`.
---

# Design laws for Launch & Own

Launch & Own's users are small-business owners, not developers. Every screen must make one next step obvious, explain ownership in plain words, and never surprise them. Apply these laws as rules. When a law conflicts with security, honesty about what is live, or the approval contract, those win.

Check your work with `npm run visual:walkthrough -- --open` (screenshots of every screen plus a consistency table).

## The laws and what they mean here

1. **Aesthetic-usability effect.** Polished screens feel easier and are trusted more. Use the shared shell (`pageShell` in `onboarding/ui.mjs`): one card, one header, one footer. No page invents its own frame.
2. **Law of proximity.** Things close together read as one group. Keep a label, its value and its action together. Separate unrelated groups with the card's section rule, not just a blank line.
3. **Von Restorff effect.** The one thing that differs is the one people notice. Each screen gets **exactly one primary button** (the next step). Everything else is a secondary button or a link. Never put two blue buttons in a row.
4. **Zeigarnik effect.** Unfinished tasks stick in the mind. Always show where the owner is in a journey and what is left, using the same step display everywhere.
5. **Tesler's law.** Some complexity can't be removed, only moved. Move it to the system: we pick the file, run the checks and confirm it's live. Don't hand the owner SHAs, branch names or file paths unless they asked (put them under "Technical details").
6. **Law of Prägnanz.** People read the simplest shape. Prefer one plain list or one card over nested boxes, badges inside pills inside panels.
7. **Serial position effect.** First and last items are remembered best. Put the status or outcome first and the primary action last. Bury nothing important in the middle of a paragraph.
8. **Progressive disclosure.** Show what this step needs, and put the rest behind `<details>`. Long explanations, file lists and hashes go in a disclosure.
9. **Law of common region.** A shared border means "these belong together". One site = one card (as the toolkit does). Don't wrap unrelated items in the same box.
10. **Goal-gradient effect.** People speed up near the finish. Make progress visible and celebrate the last step ("Live and checked").
11. **Law of similarity.** Things that look alike are assumed to act alike. The same state uses the same badge colour, and the same action uses the same label on every screen ("Approve and publish", "Open a pull request instead").
12. **Recognition over recall.** Show choices instead of asking people to remember them. Let owners pick an editable spot; don't make them retype text exactly. Repeat the site name on every screen.
13. **Pareto principle.** Most owners do a few things: launch, change text, check it's live. Make those one click from the toolkit, and push rare options lower.
14. **Occam's razor.** Remove anything that doesn't help the next step: duplicate explanations, repeated status lines, extra links.
15. **Parkinson's law.** Tasks expand to fill the time given. Keep forms short, prefill what we know, and tell the owner how long a step takes ("usually a few minutes").
16. **Uniform connectedness.** Visually connected items read as related. Use the stepper's connecting line for sequences. Don't connect things that aren't a sequence.
17. **Paradox of the active user.** People skip instructions and start doing. The interface must be usable without reading the paragraph above it: labels and buttons carry the meaning, help text is optional.
18. **Cognitive load.** Every extra word, choice and colour costs attention. Aim for one idea per paragraph and one decision per screen. Plain language, no jargon ("imported edit" → "website change").
19. **Default effect.** Most people keep the default. Defaults must be the safe, recommended choice (visitor insights on with an opt-out; "Approve and publish" with the pull-request path as the alternative), and the screen must say what the default does.
20. **Peak-end rule.** People judge an experience by its best moment and its end. The final screen of every journey (launched, change live, message sent) must be clear, positive and tell them what they now own. Error screens are "ends" too: say what happened, that nothing changed, and give the right way back for *that* flow.

## Checklist before you ship a screen

- [ ] Uses the shared shell, header, footer and content width.
- [ ] Exactly one primary button. Everything else is secondary or a link.
- [ ] Status or outcome first, next action last.
- [ ] Journey screens show the shared step display.
- [ ] No SHAs, digests or file paths outside "Technical details".
- [ ] Same words and badge colours as the other screens for the same state and action.
- [ ] Error text names the real problem and links back to the flow the owner was in.
- [ ] The final screen says what the owner now has and what happens next.
