# Independent beta acceptance — QA runbook (Issue #21)

This guide separates **verified local behavior** from **unverified customer-facing launch**. Do not mark Issue #21 done based on a simulated GitHub/Cloudflare API, a localhost demo, a green CI run, or a deployed URL without exact revision verification.

## Stage A — repeatable local rehearsal (no accounts, provider requests or billing)

Requires Node.js 22+. In a clean checkout:

```sh
npm test
npm run qa:rehearse
```

The second command generates a fictional **one-page** Willow Studio site, serves it over `127.0.0.1` and checks that the served HTML is **byte-for-byte the same** as the export and update-preview digest. It then repeats for a visibly changed headline and verifies that the two SHA-256 digests differ. Manifests, secret-like paths and non-existent pages are not served. All artifacts use a temporary directory that is deleted afterward.

Expected fields in the machine-readable evidence: `mode=offline-localhost-only`, `providerRequests=0`, `published=false`, `customerApprovalCollected=false`, `changedRevision=true`, two distinct SHA-256 values, and `localhostVerified=true`. This establishes repeatable site rendering and preview integrity **only** — not provider permissions, human approval, or publication.

For a visual walkthrough, run `npm run demo:export`, `npm run demo:serve` and open `http://127.0.0.1:4173/`. The default sample is a **four-page** demo; for the one-page customer acceptance, remove `layout: "multi-page"` in a copy of the JSON and export to a new, unused directory. Do not publish the fictional example.

### Durable launch recovery in the Worker runtime

Run this check from the repository root on Node.js 22.12 or newer:

```sh
npm ci --prefix scripts/worker-recovery
npm run qa:rehearse:recovery
```

The check bundles the current onboarding Worker with its configured compatibility settings, applies the onboarding migrations to a fresh local D1 instance, and simulates GitHub and Cloudflare with the existing provider fixtures. It drives OAuth callbacks, approval, and the Cron handler through the local Worker runtime. It advances local D1 deadlines to exercise retry and session expiry without waiting for the production schedule.

The result should show `liveProviderRequests: 0` and seven passing checks. In the rehearsal, one job survives a lost repository-creation reply and overlapping Cron invocations. Session expiry pauses the job at the pinned checkpoint. Reconnect and restore produce a private preview. The explicit reapproval then verifies the original commit and exact public HTML without recreating resources. A separate scenario checks that provider revocation pauses further work.

## Stage B — real first launch (blocked pending Domain/OAuth confirmation)

**Prerequisites:** Domain/OAuth agent confirms both actual sign-ins for `https://onboard.360web.cloud`, Worker Custom Domain/TLS, provider secrets, Cloudflare OAuth authorization-code response and the installed Workers & Pages GitHub App's access to a new customer-owned **private** repo. Do not loosen permissions or publish the private OAuth client without owner authorization.

1. Invite an independent, consenting customer (not the owner's existing test account). Obtain permission before logging non-secret evidence. Customer connects **their own** GitHub and Cloudflare through provider consent pages; nobody pastes tokens into chats or issue comments.
2. Capture the selected immutable GitHub user/account identities and Cloudflare account selection **privately**. Check deny/decline paths and mismatched account handling. No creation should occur before a visibly separate approval.
3. Customer enters real one-page content, sees the exact HTML preview, reviews the proposed private repository and Pages project, and explicitly approves publication. Record the **approved homepage SHA-256**, consent timestamp and a safe, redacted screenshot or description.
4. Confirm GitHub private repository creation, ownership marker and Pages Git source match this customer's identity. Verify Cloudflare's own Workers & Pages GitHub App can access the repository without overbroad access.
5. When the deployment finishes, obtain the full approved GitHub **40-hex commit SHA** and use the read-only verifier with **both** `expectedCommitSha` and `expectedHtmlSha256`. `status=live` is acceptable only when the canonical production commit and public HTML hash match. `pending-expected-commit`, `pending-expected-html` and `pending-public-reachability` are **not successes**. Save the verified URL, canonical deployment ID, SHA and digest in the internal test record.

Operator-only read-only verification example (never store the Cloudflare token in source control or terminal transcripts):

```sh
node --input-type=module -e '
import {readFileSync} from "node:fs";
import {verifyWebsite} from "./pipeline/verify-site.mjs";
const customer=JSON.parse(readFileSync(process.argv[1],"utf8"));
console.log(JSON.stringify(await verifyWebsite(customer,{
  cloudflareToken:process.env.CLOUDFLARE_API_TOKEN,
  expectedCommitSha:process.env.EXPECTED_GH_SHA,
  expectedHtmlSha256:process.env.APPROVED_HTML_SHA256
}),null,2));
' ./private-tester-config.json
```

The private tester config must contain the authorized `name`, 32-character `accountId` and `githubOwner`; keep it outside the repository. Set the three environment variables securely before running. A 200 response or an old successful Pages deployment **alone** does not prove the approved content is live.

## Stage C — approved update and failure recovery (currently not exposed end-to-end)

1. The same authorized owner requests one visible headline edit. Display the new HTML preview; record its SHA-256 and the exact current `main` commit.
2. After **separate human approval**, submit the reviewed copy through `previewWebsiteUpdate` / `proposeWebsiteUpdate` (the backend foundation in `pipeline/propose-site-update.mjs`). Confirm only a feature branch and GitHub pull request were created; never commit directly to `main`.
3. Require owner review, successful CI and explicit manual PR merge. Capture the **merged commit SHA**; do not assume the PR's head SHA equals the final merge SHA.
4. Verify production with both the merged SHA and the new approved HTML digest. Ensure the old digest no longer matches live content. Try a stale base-SHA update and rejected approval attempt; each must fail closed.
5. Report the PR number, check status, merge SHA, verified deployment, retry count, assistance needed and safe failures. Strip all OAuth/session tokens, private email and account IDs from public GitHub comments unless the customer explicitly approves their publication.

**Current blockers:** Hosted OAuth/live deploy is owned by Domain/OAuth (#2); persistent lifecycle and recoveries belong to Codex Max (#12); the customer-facing maintenance UI and its GitHub App PR scope are not yet enabled. **Local tests cannot satisfy Stage B or C.** Product/distribution (#22) should use this guide for the tester handoff and record their first-preview usability feedback.

## Issue #21 completion evidence template

- Tester consent and independent identity: [recorded privately / pending]
- Both hosted provider sign-ins and private GitHub repository verified: [yes/no]
- Approved one-page preview SHA-256: [64-hex or private evidence ID]
- Expected and canonical deployed GitHub SHA: [same/different + 40-hex]
- Public homepage SHA-256: [matched approved digest / not matched]
- Website URL and deployment ID: [approved public evidence only]
- Update PR / green checks / manual merge SHA: [URL + revision / pending]
- Post-update public HTML digest matches new approved copy: [yes/no]
- Denied OAuth / stale base / retry safety outcomes: [recorded]
- Manual assistance, blocker, cost/permission changes: [reported]
- QA disposition: **pass only when every real-world stage above is verified**.
