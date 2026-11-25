# PR #53 design notes and screenshots

Screenshots come from the mocked Worker test harness (fake `tester` account, placeholder SHAs). No real accounts or customer data. Remove this folder before merge if the screenshots aren't wanted in the repo.

## Component hierarchy
- `onboarding/ui.mjs`: shared tokens, header, stepper, page shell and the ZIP compatibility grid styles. Used by every `view()` page. UI options go in `view()`'s fifth argument, never the headers argument.
- `onboarding/landing.mjs` (owned by #53): signed-out page. Hero → `exploreMarkup()` tabs → ownership strip → FAQ → `#get-started` (existing provider connection cards, the only OAuth entry) → final CTA.
  - Copy switches on the strict server ZIP flag (`zipPreviewConfigured(env) === true`): ZIP-first hero ("Build anywhere. Own everything.") with the simple builder as fallback, plus `zipCompatibilityHtml` (also shown on the upload form).
  - `exploreMarkup()` builds Launch / Maintain / Grow from #164's `marketingPipelineMarkup()`, `aiUpdateJourneyMarkup()` and `serviceExplorerMarkup()`, **consumed unchanged** (#164 owns those files). A test guards the markers it slices on.
  - Maintain adds two paths: own AI coding tool (available with your own tools) and the customer-owned website assistant (*planned · not released*, #165).
- Tabs are native radio inputs styled with `:has()`. No script, no CSP change. Without `:has()` support all panels stay visible.
