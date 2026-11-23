# Safe website changes after launch

Launch & Own's website maintenance promise is **preview → explicit approval → GitHub PR → human merge → deployment verification**, never a direct unreviewed write to the live branch.

## Implemented in this milestone

`pipeline/propose-site-update.mjs` exposes two reusable operations:

- `previewWebsiteUpdate(input)`: deterministic website HTML plus its SHA-256 digest. **No network calls, no provider credentials.**
- `proposeWebsiteUpdate(input, {githubToken, fetchFn})`: requires `explicitlyApproved: true`, a matching `approvedHtmlSha256` and the exact current `expectedBaseCommitSha` from the repository's `main`. It verifies the signed-in immutable GitHub user ID, exact private Launch & Own managed repository marker and current branch SHA, then stages the new `public/index.html` on a deterministic `launch-and-own/site-...` branch and creates/reuses a GitHub PR.

**No customer publication happens in this module.** It does not merge the PR, write to `main`, trigger Cloudflare directly, alter DNS, install apps, change billing or claim that a Pages deployment is live. The customer must review and **separately merge** the PR. After merging, verify that Cloudflare's production canonical deployment serves the exact merged SHA (use `pipeline/verify-site.mjs`).

## Required input shape

```js
const proposal={
  name:"Willow Studio",
  githubOwner:"customer-github-login",
  accountId:"<the customer's verified Cloudflare account ID>",
  site:{
    tagline:"A newly approved homepage headline",
    about:"What this real business offers...",
    services:["Family portraits","Community events"],
    theme:"forest",
    contactEmail:"hello@example.com"
  }
};
const preview=await previewWebsiteUpdate(proposal);
// The customer must see the rendered HTML and approve it, and the caller
// must re-read the current main commit SHA and bind it to that approval:
const approved={
  ...proposal,
  explicitlyApproved:true,
  approvedHtmlSha256:preview.htmlSha256,
  expectedBaseCommitSha:"<40-hex commit SHA actually reviewed by the customer>"
};
const result=await proposeWebsiteUpdate(approved,{githubToken:authorizedToken});
```

The **customer-facing onboarding workflow is implemented in PR #31 / Issue #30** (pending review, CI and coordinated deployment) for verified *live one-page* launch jobs. From the authenticated `/history` page, a live site owner chooses **Edit this website**, reviews fields and a read-only GitHub `main` revision, opens the rendered HTML preview, and explicitly approves a reviewable PR. The server obtains the currently connected user's GitHub credential. The review receipt is AES-GCM-encrypted and bound to the active session, authorization epoch, user ID, Cloudflare account, exact commit and HTML digest for 15 minutes. Site owner/repository identity always comes from the owned launch record, not submitted form values.

After PR creation the authenticated `/site-update-status` link checks the exact expected PR branch and, after manual merge, the canonical Cloudflare deployment's GitHub commit **and** public HTML SHA-256. Status receipts expire after 30 days and require a valid session with the same verified provider accounts; they contain no OAuth credentials. No PR creation means no publication. All provider writes remain behind explicit user approval and the owner-controlled GitHub PR permission. This workflow needs no new D1 migration or Worker binding.

**Beta limitations:** only *live one-page sites with unexpired 30-day launch history* are editable, and the form starts with the original approved fields, not changes made independently in GitHub. Every proposal checks the current GitHub base and fails if it has advanced. Customers must manually merge and can re-check verification before the receipt expires. Four-page editing and durable post-retention site discovery need a future milestone.

## Security and recovery behavior

- Only the **same GitHub personal owner** may propose a change; both `/user.id` and `repo.owner.id` must match and the repo must have a private managed marker.
- An unknown or unrelated repository is **never adopted or written to**.
- If `main` advanced after approval, stop and request a fresh preview; **never quietly rebase a changed site**.
- The exact HTML SHA-256 must match the approved preview before any provider request.
- Existing feature branches with unrelated edits are refused; interrupted creation can resume safely, and already-open PRs are reused without duplicate writes.
- Closed PRs cannot be silently recreated. An already-up-to-date homepage is a no-op.
- Do not log tokens or embed credentials in PR text. Do not apply changes to customer forms or custom domains.

## Permissions / rollout

The GitHub App currently planned by the domain agent has Repository creation and Contents write. **Maintenance PRs also require the appropriate GitHub App `Pull requests: write` permission** for the signed-in customer. Coordinate that permission change with the domain/OAuth agent on [Issue #2](https://github.com/mitchelldawkinsjr/launch-and-own/issues/2), obtain explicit approval for new scopes, and independently verify installation consent and behavior. Do not expand app permissions without the owner authorizing it.

This code uses **mock GitHub APIs in CI**, not a live customer repository. The first production update acceptance test must show: reviewed page and base SHA → separate approval → only a feature branch and PR created → manual merge → exact-commit Cloudflare verification. Until then the hosted frontend does not offer live website change requests.

The module works without any paid AI service. AI-generated proposed copy must pass the same preview and approval checks; the AI model is not authorized to create branches, PRs or publish sites.

## Hosted self-service route acceptance (Issue #30)

1. With a verified owner-account session and an owned live one-page job, open `/history` and select **Edit this website**. Before any approval, only GitHub/Cloudflare read calls should occur.
2. Submit a headline update, open the exact preview, check the immutable base commit and SHA-256, and approve a **GitHub PR**. Verify `main` has not changed and the PR only stages `public/index.html` on a feature branch.
3. Explicitly review and merge that PR in GitHub. Refresh the signed-in status link until canonical Cloudflare production commit SHA and served HTML digest match. Pending commit/HTML means **not live**.
4. Verify malformed/expired review tickets, other sessions/tenants, mismatched GitHub repositories, revoked grants, invalid CSRF, and stale `main` all fail without new provider writes. The Worker tests simulate the complete sequence but **are not a real customer acceptance test**.
5. The Domain/OAuth agent must confirm the owner's GitHub App **Pull requests: write** consent before any live PR attempt. Coordinate Worker deployment with the #21 live pilot owner; never change DNS or public client visibility from this implementation.
