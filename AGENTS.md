# Launch & Own — contributor guidance

Launch & Own is a customer-owned conversational website launch platform, **not** a single customer website.

- Preserve the promise **Describe it. Launch it. Own it.**, but distinguish implemented, simulated, and live-verified functionality.
- Require tenant ownership checks, explicit resource-creation approval, private tokens, and GitHub SHA-pinned deployment verification.
- Keep onboarding D1 separate from every customer's contact-form data.
- Never commit or expose GitHub/Cloudflare tokens, OAuth client secrets, personal submissions, or encryption keys.
- Run `npm test` and use a PR with passing CI for changes.
- Do not claim hosted OAuth onboarding is live without real consent, infrastructure, and independent customer acceptance.
