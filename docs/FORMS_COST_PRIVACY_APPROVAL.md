# Forms cost and privacy approval — #89

Review-only contract for the missing gate that `pipeline/approved-extension-consumer.mjs` already requires before any Turnstile, customer D1, or form Worker create.

## What this is

`pipeline/forms-cost-privacy-approval.mjs` builds a digest-bound plan and verifies a **separately stored, status=`approved`** row into the `stored-cost-privacy-approval` gate shape:

- exact `#88` forms consent digest
- same job, GitHub user, Cloudflare account, and Pages project
- owner-acked cost and privacy
- personal contact data with time-bound deletion
- bounded retention (1–365 days), submissions/day (1–1000), and body size (256–65536 bytes)
- Workers + dedicated customer D1 only; never platform ZIP R2

`canActivate`, `canWrite`, and `createResources` stay **false** on the review and on the verified gate object. The consumer still owns ordering of provider adapters and end-to-end acceptance.

## What this is not

- Not `prepareOptionalExtensionReview` / a budget `planDigest`. Those remain non-activating forecasts.
- Not `#88` forms consent alone. Consent without this approved gate fails closed.
- Not a D1 migration, Worker route, OAuth expansion, billing checkout, or live form.
- Not permission to invent hostnames or reuse onboarding D1 for customer submissions.

## Next hosted steps (Domain / #2)

1. Add an operator-approved D1 table for these approved rows (separate from `onboarding_option_approvals` `stored` consent).
2. Wire `verifyFormsCostPrivacyGate` to load the approved row server-side and call `verifyStoredFormsCostPrivacyApproval`.
3. Only then schedule provider adapters and independent #21 acceptance.

Sol coordinates under [#83](https://github.com/mitchelldawkinsjr/launch-and-own/issues/83). Parent: [#89](https://github.com/mitchelldawkinsjr/launch-and-own/issues/89).
