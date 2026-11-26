# Launch & Own — contributor guidance

Launch & Own is a customer-owned conversational website launch platform, **not** a single customer website.

- Preserve the promise **Describe it. Launch it. Own it.**, but distinguish implemented, simulated, and live-verified functionality.
- Require tenant ownership checks, explicit resource-creation approval, private tokens, and GitHub SHA-pinned deployment verification.
- Keep onboarding D1 separate from every customer's contact-form data.
- Never commit or expose GitHub/Cloudflare tokens, OAuth client secrets, personal submissions, or encryption keys.
- Run `npm test` and use a PR with passing CI for changes.
- Do not claim hosted OAuth onboarding is live without real consent, infrastructure, and independent customer acceptance.

## Cross-agent distribution and release

- [Issue #55](https://github.com/mitchelldawkinsjr/launch-and-own/issues/55) is the coordination umbrella; [Issue #43](https://github.com/mitchelldawkinsjr/launch-and-own/issues/43) owns the shared authenticated MCP/API. Keep portable skills and Claude/ChatGPT clients thin; **never** implement a second publishing stack or grant agents unilateral resource-creation authority.
- Review [the distribution release matrix](distribution/release-matrix.json) and [release guide](docs/AGENT_DISTRIBUTION_RELEASE.md) before claiming beta/public capabilities. Run `npm run qa:distribution` plus `npm test`. Owner-only live evidence is **not** independent customer acceptance. Request orchestration review before changing the release matrix.
- Domain/OAuth owns Launch & Own's provider permissions, secrets and production deployments. Keep ZIP hosted-disabled until R2/private preview acceptance (#45). Coordinate shared Worker edits between draft PRs #31 and #53.

## Customer-owned assistant (#165)

These rules apply the ones above to the planned customer-owned assistant. Its design is in [PR #170](https://github.com/mitchelldawkinsjr/launch-and-own/pull/170) (`docs/design/personal-assistant/`). It's design-only until M1.5 acceptance.

- **Not a second publishing stack.** The assistant may only run the same WS2/WS3 editing, preview and PR library the hosted product uses, relocated rather than forked. It must follow the same [approval contract](docs/contracts/IMPORTED_SITE_CONTRACTS.md). A separate or reimplemented publishing path is still prohibited.
- **Who deploys what.** Domain/OAuth owns Launch & Own's central permissions, secrets and production, and signs off each upstream assistant template release. Deployments into a customer's own GitHub and Cloudflare accounts are run and owned by the customer. Launch & Own never holds a durable credential for them and never expands its OAuth scopes for them without a Domain review.
- **No agent provisioning.** The model inside the assistant never creates, changes or deletes provider resources. It may cause a branch and PR only after an owner approval bound to the exact revision. If the owner chose *Approve and publish* (2026-11-26), the server, not the model, merges that exact PR under the guards in the imported-site contract. Provisioning, updates and uninstall are run by the customer with explicit consent.
