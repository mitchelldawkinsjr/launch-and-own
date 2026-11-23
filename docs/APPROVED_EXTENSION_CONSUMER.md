# Stored post-launch extension approval consumer — #88 Agent 2 (GPT-6)

This is a **server-only execution contract**. It consumes Agent 1's separately stored customer domain, email and forms approval rows, not a new consent UI. It has no import-time provider requests and is not wired to a hosted Worker or applied migration.

## Required D1 integration

File: pipeline/approved-extension-consumer.mjs. Export: consumeStoredToolkitApproval.

The only caller-controlled selector is an opaque approval ID. The backend supplies a current server-authenticated GitHub user, current selected Cloudflare account and current OAuth session epoch. Inject four trusted adapters:

- approvalStore.readApproved: return the matching row from D1 for the current GitHub user and Cloudflare account, not a browser-submitted record.
- siteStore.readLiveSite: independently resolve the exact live launch job, private repository ID, Pages project ID/name and production branch.
- assertCurrentAuthorization: verify current session, provider authorizations, account and site identity before and after external operations.
- approvalStore.claimApproved / finish / fail: implement atomic single-winner compare-and-swap approved → applying → applied with an operator-reconciliation failure path. The claim MUST compare ID, job ID, GitHub user ID, account ID, kind, digest, full immutable payload JSON and approved status. A lost race may never write providers. Do not auto-retry a partial provider write after receipt or network failure.

Expected row columns: id (UUID), job_id (UUID), github_user_id (integer), cloudflare_account_id (32 hexadecimal characters), kind (domain/email/forms), approval_digest (64 hexadecimal SHA-256), payload_json (serialized reviewed request), status (approved, applying, applied or an operator-reconciliation state). **These fields and state values must be reconciled with Agent 1's actual migration before any route is wired.** These approval rows are not launch-job/launch-approval rows. No hosted D1 migration apply is part of Agent 2's PR.

Payload contracts: domain contains hostname; email contains hostname and external mailbox; forms contains hostname, name and ownerEmail. Domain and email digest recomputation uses the existing buildDomainApprovalReview with domainConsent=true, exact GitHub user and selected Cloudflare account, and the mailbox for email. Forms recomputation uses planCustomer with forms=true and formsConsent=true and the existing formsReview digest. The module does not accept an arbitrary claimed digest as approval.

Provider adapter is backend-only: readPagesProject, readGithubRepository, readPagesDomain, attachPagesDomain, readOwnedZone, readEmailRoutingSettings, readVerifiedDestination, readEmailRoutingRule, createEmailRoutingRule, createTurnstileWidget, createCustomerD1, deployServerVerifiedFormWorker and verifyFormAcceptance. All provider URLs and tokens must come from the current trusted owner session. Provider adapters must be idempotent, verify returned resource IDs and reject redirects, external-resource collisions and non-owner scopes.

## Domain attachment

Only attach the digest-approved hostname to the exact, currently verified customer's Git-integrated Pages project. The consumer compares immutable GitHub repo owner/ID and private flag, Pages project ID and source, production main and static build output. Recheck session at every provider boundary. The Pages custom domain can be pending DNS/TLS after attachment; pending does not mean live. No DNS, nameserver, SPF, DKIM or MX mutation or domain purchase is authorized.

Cloudflare API reference: https://developers.cloudflare.com/api/resources/pages/subresources/projects/subresources/domains/methods/create/ (Pages Write; POST /accounts/{account_id}/pages/projects/{project_name}/domains).

## Email Routing

An email approval is distinct from the domain approval, and must include the exact approved hostname and existing external forwarding mailbox. Require an **applied domain D1 row** for the same job, user, account, and hostname (recompute its digest) and a currently active Pages domain on the same project. Independently require a matching active Cloudflare zone in that account, pre-existing Email Routing status ready, a verified existing destination address and no conflicting rule. The existing digest cannot authorize arbitrary aliases: this narrow first slice only permits the fixed contact@approved-hostname alias. Create only an Email Routing rule with one literal recipient matcher and one forward action. Never enable Email Routing DNS, change MX, create a mailbox, send outgoing email or send destination verification mail. Current Pages-only OAuth permissions do not include the Email Routing Rules Write scope.

Cloudflare API reference: https://developers.cloudflare.com/api/resources/email_routing/subresources/rules/methods/create/ and https://developers.cloudflare.com/email-service/configuration/email-routing-addresses/

## Turnstile + forms — release blocked by #89

Only the stored forms consent row and matching canonical planCustomer formsReview may authorize the forms path. The current #89 optional-service review planner is always nonactivating; its proposal digest, a client boolean, and a Turnstile widget cannot enable form provisioning.

A new, independent server-only gate must verify a **separate approved #89 cost/privacy D1 record** for the same job, owner, account, Pages project and exact forms digest, with user-approved usage budget, billing/permissions, personal-data retention/deletion and bounded size/rate limits. With that gate, the consumer orders customer-owned, idempotent Turnstile widget → separate customer D1 → server-verified form Worker → independent actual form acceptance. The Worker must use server-only Siteverify with single-use tokens, dedicated D1 bindings, per-customer abuse limits and retention. WorkingForm remains false until full server-Siteverify plus D1 and end-to-end acceptance. The actual provider implementations, approved #89 D1 record, secret handling, real worker deployment and live acceptance are **not yet implemented** by this contract; the forms path is not a shippable feature today. Static Pages remains usable without any extension.

## Rollout, QA and rollback

A lost claim, revoked OAuth, wrong tenant, changed repository, mismatched project, invalid digest, email-before-domain, unverified destination, forms without consent or #89 approval must fail closed. A failed/unknown external action must require operator reconciliation rather than blind retry. Domain unlink, email-rule deletion and D1 data deletion/export each require separate approval and privacy review; a Git revert does not delete contact data.

Tests: node --test pipeline/approved-extension-consumer.test.mjs. Full npm test + distribution QA + Worker/D1 recovery checks remain required.

**No hosted deployment, DNS/MX/account mutation, billing or OAuth permission expansion is performed in Agent 2's PR.** Keep #53 onboarding redesign and #21 independent beta test untouched. Sol #83 review, Domain #2 approval, Agent 1's confirmed D1 adapter and #89 live gate are prerequisites for any customer execution.

**Implementing model: GPT-6 (OpenAI), Agent 2.**
