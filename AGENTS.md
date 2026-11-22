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
- Domain/OAuth owns provider permissions, secrets and production deployments. Keep ZIP hosted-disabled until R2/private preview acceptance (#45). Coordinate shared Worker edits between draft PRs #31 and #53.
