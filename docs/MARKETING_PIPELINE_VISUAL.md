# Marketing landing visual — integration handoff

Open [marketing-pipeline-preview.html](marketing-pipeline-preview.html) locally in a browser for the standalone concept. It is a design preview with the ZIP option illustrated, not a deployed or functional onboarding page.

The reusable Worker-compatible component is `onboarding/marketing-pipeline.mjs`. It exports scoped inline CSS and semantic HTML, needs no script, external fonts, images, account data, or new permissions. The inline GitHub icon is reused from the existing provider guide; other icons are illustrative.

## Integrate after #53 reconciliation

- Import `marketingPipelineCss` and `marketingPipelineMarkup` into the final onboarding shell. Use a wide layout only for the signed-out landing page; keep the current authenticated setup layout.
- Add the scoped CSS to the existing inline style block; render `marketingPipelineMarkup({zipEnabled: zipPreviewConfigured(env)})` on the signed-out page. Keep existing provider connection cards/action links and disconnect notices beneath or adjacent to the visual. A primary CTA can point to the existing `/connect/github` action or scroll to the provider section; do not add a second OAuth flow.
- The numbered graphic is a conceptual workflow, not live account state. Never replace the actual preview/approval or deployment verification gates with it. Keep the current CSP, no-store and security headers, and preserve existing account/CSRF routes. Keep the public ChatGPT publishing path and post-launch feature claims gated by the release matrix.
- Desktop: review around 1280–1440px; mobile: review around 360–390px. Test keyboard disclosure, readable text, no horizontal scroll, and the current GitHub/Cloudflare setup flow. Run npm test and npm run preflight:onboarding before requesting release approval.
- Coordinate with #2 and #41/#53. This PR intentionally does not edit worker.mjs, merge, change release status, or deploy.
