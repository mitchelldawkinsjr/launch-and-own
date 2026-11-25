# PR #53 design notes and screenshots

Screenshots came from the mocked Worker test harness (fake `tester` account, placeholder SHAs). They were removed from the branch before release to keep binaries out of the repo; the PR #53 and #168 progress comments link to them at their pinned commits, so those links still work.

## Component hierarchy
- `onboarding/ui.mjs`: shared tokens, header, stepper, page shell and the ZIP compatibility grid styles. Used by every `view()` page. UI options go in `view()`'s fifth argument, never the headers argument.
- `onboarding/landing.mjs` (owned by #53): signed-out page. Hero → `exploreMarkup()` tabs → ownership strip → FAQ → `#get-started` (existing provider connection cards, the only OAuth entry) → final CTA.
  - Copy switches on the strict server ZIP flag (`zipPreviewConfigured(env) === true`): ZIP-first hero ("Build anywhere. Own everything.") with the simple builder as fallback, plus `zipCompatibilityHtml` (also shown on the upload form).
  - `exploreMarkup()` builds Launch / Maintain / Grow from #164's `marketingPipelineMarkup()`, `aiUpdateJourneyMarkup()` and `serviceExplorerMarkup()`, **consumed unchanged** (#164 owns those files). A test guards the markers it slices on.
  - Maintain adds two paths: own AI coding tool (available with your own tools) and the customer-owned website assistant (*planned · not released*, #165).
- `onboarding/import-report.mjs`: `importReportMarkup(inventory)` renders the approved inventory format (contract §1) as a plain-language compatibility check: upload accepted / ready in a browser / can be published, findings, the planned-editing note and the file list. **Not wired to a route** until the WS1 inventory exists and M1.5 is authorized. Screenshots `report-*.png` use example inventories.
- `onboarding/edit-review.mjs`: `editReviewMarkup({proposal, binding, status, code, approve})` renders contract §2–§4: request summary, status timeline, each change as before → after (hex swatches only for strict hex colors), "every other file stays the same", the exact-preview link (https only, only while `previewed`), and the single-use approval form carrying `csrf`, `approvalId`, `proposalDigest`, `artifactDigest` (same-site action only). Failures map §4 codes to plain language and never show the form. **Not wired to a route.** Screenshots `edit-review-*.png` use an example proposal.
- Tabs are native radio inputs styled with `:has()`. No script, no CSP change. Without `:has()` support all panels stay visible.

## Accessibility audit (automated, Chromium, real Worker headers)
Pages: landing (ZIP on and off), setup with the upload form, review, privacy. All disclosures open; reduced motion emulated.
- Contrast (WCAG AA, effective background including alpha): 479 text elements, **0 failures**. Text over gradients appears only in the decorative, `aria-hidden` hero illustration.
- Structure: one `<h1>` per page, no skipped heading levels, `banner` / `navigation` / `main` / `contentinfo` landmarks, skip link to `#main`, every form field labelled.
- Keyboard: Tab through every focusable element on each page; all show a visible focus ring (tab labels draw the ring for their radio).
- Screen-reader tree: the explorer reads as group "Choose what to explore" with three radios and the checked state; inactive panels are removed from the tree.
- Reduced motion: smooth scrolling off.
- Not yet done: a manual VoiceOver/NVDA walkthrough by a person. The automated checks don't replace it.
