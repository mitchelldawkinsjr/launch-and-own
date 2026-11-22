# Launch & Own — two entry points, one ownership and publication platform

**Product decision:** ChatGPT-first conversational building and standalone web onboarding are **two first-class experiences**, backed by the **same secure Launch & Own system**.

**Product promise:** *Describe it. Launch it. Own it.*

**Architecture status:** This is the target product contract and phased plan, not a statement that AI-connected flows are deployed. The live browser beta offers provider OAuth, a manual one-page editor **and owner-verified static ZIP upload**. A real independent customer launch is still undergoing acceptance in [#21](https://github.com/mitchelldawkinsjr/launch-and-own/issues/21). The existing private `elite-site-pipeline` ChatGPT plugin v0.3.0 is **skills-only**, not a hosted MCP integration, and cannot by itself provision sites via Launch & Own APIs.

## Product surface A: Build and maintain in ChatGPT

**Best for:** people who want to describe, refine and change a website through conversation.

**User journey:**
1. In ChatGPT, ask to create a website, e.g. "Build a website for my landscaping business. Use green and cream. I want Home, Services and Contact."
2. The model asks targeted clarifications only as necessary, produces structured site specifications and content. It can guide design decisions or request supported imagery. It **does not publish directly**.
3. The Launch & Own plugin calls an authenticated, tenant-scoped backend to prepare the actual deployable website artifact (HTML and assets) and receives an exact reviewable immutable revision/digest. An inspirational visual is never represented as the exact deployable preview.
4. First-time user connects **their own GitHub and Cloudflare** in the official hosted browser consent UI. Link the resulting verified identity to the same in-progress site draft; never return provider credentials, OAuth codes or grant material to the model.
5. ChatGPT shows a safe exact-preview link and an explicit summary of the target private repository, public website, accounts and any costs. **Approval is a separate customer act** checked by the Launch & Own backend and bound to the immutable preview digest and target; no model-only tool call should bypass it.
6. On approval, the shared durable job creates/updates approved customer-owned resources and verifies the exact production commit and approved public content. ChatGPT reports the observed state: pending, paused, awaiting consent, failed, or **verified live** only with evidence.
7. Later, the customer says "Update the headline and add wedding packages." The plugin reads the latest authorized managed website source, prepares a **new** exact preview, obtains a separate approval, creates a reviewable PR and verifies publication after owner-approved merge. Never silently overwrite main or claim a PR is live.

**ChatGPT responsibilities:** interpret the brief, suggest information architecture and copy, help with iterative changes, render accessible explanatory conversation, and optionally help prepare imagery when the integration supports transferring generated assets. No independent paid backend LLM is required for a standard conversational request if ChatGPT provides the draft.

**Launch & Own backend responsibilities:** authorization, tenant linking, source-of-truth storage, deterministic final artifact creation, secure asset intake, preview origin, immutable approvals, GitHub/Cloudflare orchestration, durability, cost/permission disclosure, deploy verification, revocation and logs. Model output is untrusted until validated and reviewed.

**Open platform work:** secure MCP/API tool bridge and connected plugin experience [#43](https://github.com/mitchelldawkinsjr/launch-and-own/issues/43). The existing personal skills-only plugin is a separate preliminary workflow guide; preserve it until an approved update is ready.

## Product surface B: Standalone web onboarding

**Best for:** someone who already has a website ZIP or wants a simple web form without using ChatGPT.

**Entry:** https://onboard.360web.cloud

**Web options:**
- **Upload an existing website (.zip):** stage privately, validate types/sizes/paths/scripts, show a private exact original-bundle preview, identify proposed private GitHub repo and Pages target, separately approve, publish and verify. It is **enabled in the hosted browser beta**, after Domain implemented private storage, isolated preview, and exact 5/5-file owner-consented publication QA ([#45](https://github.com/mitchelldawkinsjr/launch-and-own/issues/45#issuecomment-7087063896)). Independent customer acceptance and large-upload Workers plan/quota review remain open.
- **Create a simple website:** manual business name/headline/about/services/contact/theme form, exact HTML preview, approval and launch. This is the current browser beta; it must **not** require ChatGPT or a paid inference API.
- **Manage an existing site:** show owned sites, status, private repo and public URL; support restoring approvals and, after separately shipping the maintenance editor, approved changes. Long-term site discovery and latest-content editing are future milestones ([#39](https://github.com/mitchelldawkinsjr/launch-and-own/issues/39)).

**The UI/UX agent [#41](https://github.com/mitchelldawkinsjr/launch-and-own/issues/41) owns this standalone experience.** Its start screen should make the two web options obvious: "Upload my website ZIP" and "Create a simple website." It should not reconstruct ChatGPT's conversational AI editor, and neither web path should depend on ChatGPT subscription or provider-connected AI.

## Shared platform (one source of truth)

```text
  ChatGPT + Launch & Own plugin              Standalone onboard.360web.cloud
  Conversation / edit requests               ZIP import / manual create / account UI
                |                                         |
                +------------- authenticated ------------+
                                      |
                            Launch & Own backend
             verified user + Cloudflare account + managed site
             normalized site/artifact record + exact preview
                    immutable consent + revision digest
                  durable, idempotent publication job
                             /              \
                    GitHub owned repo    Cloudflare owned Pages
                             \              /
                   canonical commit + public HTML verification
                                      |
                   same site dashboard, status and history
```

**Shared identifiers:** immutable verified GitHub user ID, authorized Cloudflare account ID, managed repository ID, Pages project identity, and stable Launch & Own site ID. A session/approval ID is not the site's permanent identifier.

**Shared source model:** a site has a source kind such as `generated`, `uploaded-zip`, or `managed-existing`. Every source kind resolves into a validated, immutable **prepared artifact** with an approved bundle digest and target. ZIP bytes, generated text and LLM suggestions may follow different validation paths, but **the approval and publication boundary is shared**. Never treat a model-generated design preview as exact ZIP bytes or vice versa.

**Draft vs site vs deployment:** distinguish user-editable drafts, immutable approved artifact revisions, the owner-controlled GitHub source, and deployments in progress. "Preview created" and "deployment queued" are never "live."

**Account linking:** a ChatGPT session may send the customer to the hosted OAuth screens, but the result must bind a short-lived linking challenge to the same authenticated customer and selected provider accounts. Do not place GitHub/Cloudflare tokens in ChatGPT messages, plugin arguments, query strings or public logs. Unmatched account, changed permission, expired authorization or changed site must fail closed.

**Explicit approval:** present the human with the actual site preview, target repo/project/account, public visibility and any charges. Store backend-verified consent bound to content digest and exact target identity before allowing the publication job to mutate provider resources. ChatGPT conversational text alone is not sufficient evidence.

**Same lifecycle:** both entry points call the same persisted job runner, recovery, owner identity checks, immutable revision checks, Pages verification and safe error mapping. Actions must be idempotent with observable errors; no duplicate repository creation on retry.

**Long-term maintenance:** 30-day onboarding receipts are temporary consent/history evidence, not permanent site inventory. #39 must solve later site discovery, latest source synchronization and repeat updates without retaining private submission bodies indefinitely.

**Provider connections:** if user has authorized both accounts on the web, ChatGPT must request appropriately scoped linking; it cannot assume an unrelated ChatGPT account equals the website owner. Revoked consent invalidates future tool writes in either entry point.

**Permissions and safety:** never grant production mutations based only on a model instruction, unsolicited plugin tool call, unverified ZIP source, guessed repository, or old authorized receipt. PRs require review and a separately authorized merge. Automated "one-click publish" is a separate future product decision and would still require separate explicit consent.

## Suggested minimal backend tool contract (future, not implemented)

| Group | Example operation | Behavior |
| --- | --- | --- |
| Account | `get_connection_status` | Read-only current linked owner and account; no tokens |
| Account | `begin_provider_connection` | Short-lived, owner-bound hosted OAuth action |
| Inventory | `list_owned_sites` / `get_site` | Read-only tenant-verified site inventory, current source and status |
| Draft | `prepare_site_draft` | Validate structured model output; no provisioner write |
| ZIP | `begin_zip_import` | Handoff to isolated web upload and preview, subject to secure storage |
| Review | `get_exact_preview` | Read-only safe preview URL and artifact digest |
| Approval | `request_publish_approval` | Return separate backend-controlled human confirmation; no silent commit |
| Job | `get_publication_status` | Durable job state + verified revision evidence |
| Maintenance | `prepare_site_update` | Compare latest source and create an immutable proposal; no direct main write |
| Maintenance | `request_update_approval` | Separate owner consent; approved feature PR, not live merge |
| Verify | `verify_live_revision` | Check canonical production SHA and exact public content |

These are product-level proposed operations. Implement them only after specifying response schemas, auth/permissions, quotas, audit logging and tests; do not claim the plugin can call these today.

## Ownership and development boundaries

| Work | Owner/issue |
| --- | --- |
| Live customer provider-backed first launch and exact SHA acceptance | [#21](https://github.com/mitchelldawkinsjr/launch-and-own/issues/21) |
| Shared backend safety, OAuth, D1, domain and release coordination | [#2](https://github.com/mitchelldawkinsjr/launch-and-own/issues/2) |
| Standalone web responsive UX / two user options | [#41](https://github.com/mitchelldawkinsjr/launch-and-own/issues/41) |
| Standalone private ZIP import/isolated preview | Code merged in [PR #40](https://github.com/mitchelldawkinsjr/launch-and-own/pull/40); hosted rollout [#45](https://github.com/mitchelldawkinsjr/launch-and-own/issues/45), Domain/QA |
| ChatGPT plugin/API bridge | [#43](https://github.com/mitchelldawkinsjr/launch-and-own/issues/43), unassigned |
| Approved post-launch edit PR | [Draft PR #31](https://github.com/mitchelldawkinsjr/launch-and-own/pull/31) |
| Long-term site ownership/current source after receipts expire | [#39](https://github.com/mitchelldawkinsjr/launch-and-own/issues/39) |

## Release sequence

1. Independent live owner/provider acceptance (#21); no blanket release of code based only on mocked CI.
2. Private ZIP storage and isolated preview are now enabled in the browser beta (#45). Next verify an independent consenting customer and confirm Worker CPU/plan allowances for larger ZIP uploads before broader claims.
3. Ship standalone web UX #41 after coordinating overlapping Worker changes (#31 and #40).
4. Build and security-review a shared authenticated site/artifact API for ChatGPT #43; connect the plugin to **the same backend**, with end-to-end owner consent.
5. Test both independent entry points with real consenting beta users; verify source bytes, ownership, published commit, public HTML and account isolation. Gradually enable features without making them mutually dependent.

**Acceptance principle:** The customer may enter through chat or the website and owns the same site afterward. Their site should not be bound to a single ChatGPT conversation, browser cookie, 30-day launch receipt, or a vendor-controlled hosting account.
