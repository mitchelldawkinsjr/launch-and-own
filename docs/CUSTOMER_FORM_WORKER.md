# Customer-owned contact forms

The forms execution path stages a Turnstile widget and a dedicated customer D1 after separate operator approval and a current cost and privacy grant. The result `form_resources_staged` includes a Worker review with the exact source digest, bindings and retention schedule. The product shows the setup as pending Worker review.

| File | Role |
| --- | --- |
| `pipeline/customer-form-d1-schema.sql` | Dedicated customer D1 schema for submissions and replay protection |
| `pipeline/customer-form-worker.mjs` | Reference runtime and mocked acceptance rehearsal |
| `pipeline/customer-form-worker-source.mjs` | Deployable Worker module with a bounded request body, server-side Siteverify, atomic daily quota and retention cleanup |
| `pipeline/forms-provider-plan.mjs` | Staging write allowlist and secret-free Worker review |
| `onboarding/migrations/0010_forms_provisioning_receipts.sql` | Onboarding-only staging receipts and a data-preserving cost/privacy ledger update |

## Staging and recovery

| Step | Approved operation | Required receipt |
| --- | --- | --- |
| Turnstile | Create the managed widget for the exact project `pages.dev` hostname | Current gate and empty widget checkpoint |
| Customer D1 | Create the dedicated project forms database | Recorded widget sitekey |
| Schema | Apply the exact reviewed schema to the recorded database UUID | Recorded widget and customer database, with schema pending |

Staging checks the current owner, selected account, Pages and GitHub source, exact stored consent, cost/privacy gate, and operator grant. Each verified provider response is saved before continuing. If a response is ambiguous, a same-name resource goes to reconciliation. An approved retry reuses recorded checkpoints and the schema safely supports a repeat on the exact database. The two platform D1 database IDs are excluded from customer forms actions.

Migration `0010` preserves existing cost/privacy grants and their job retention rule. Current execution still joins a gate to the current option ID and digest. When the owner approves again, the replacement gets a new ID and prior gate and receipt rows remain scoped to the earlier approval for reconciliation.

## Worker review and acceptance

The staging adapter has three write operations, all for Turnstile and customer D1. The Worker review specifies the script name, module SHA-256, exact database and hostname bindings, limits, retention cron, and required secret binding name. The provider's script-name upload, schedule, and subdomain operations require a separate rollout with verified resource identity. Any future acceptance must prove the owner's one-time Siteverify-passed test against the exact deployed version and customer D1. Public `/health` reports liveness.

Domain coordinates `0010` on the dedicated onboarding beta D1 before a compatible Worker rollout. Forms scopes and activation stay gated on an owner-approved pilot. Independent customer acceptance is tracked separately. [#89 acceptance contract](https://github.com/mitchelldawkinsjr/launch-and-own/issues/89#issuecomment-7111888230) · [#21](https://github.com/mitchelldawkinsjr/launch-and-own/issues/21)
