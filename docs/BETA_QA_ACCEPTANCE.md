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

## Stage B — real first launch (owner B13 fully verified; independent customer outstanding)

**Prerequisites:** Domain/OAuth confirms actual sign-ins for `https://onboard.360web.cloud`, Worker TLS and secrets, Cloudflare authorization-code response, and **both** the Launch & Own and Workers & Pages GitHub App installations with the appropriate customer permissions. Do not loosen permissions or change public OAuth settings without owner authorization.

**Owner B13 evidence, November 22, 2026:** A private customer-owned test repo and Git-connected Pages project exist. Canonical Pages production deployment reports success for Git commit `1b119a2cd7c99cd99bb1148f6548c303dcae122b`; the dedicated D1-approved homepage bytes match GitHub `public/index.html` at that commit. Subsequent [Domain/QA acceptance](https://github.com/mitchelldawkinsjr/launch-and-own/issues/21#issuecomment-7086107082) confirmed the D1 job is **`live`**, public HTTP 200, and the **approved/public HTML SHA-256 both equal `285c231b5ca5d7f001c8a02026576243515bcae1385f139ee2e43b52653fc610`**. These are **owner-account** results, **not** acceptance for an independent consenting customer; see [#21](https://github.com/mitchelldawkinsjr/launch-and-own/issues/21). The current browser beta has since added ZIP upload and the post-launch editor. Domain reported the deployed onboarding build and a successful health check in #2. [ZIP evidence](https://github.com/mitchelldawkinsjr/launch-and-own/issues/45#issuecomment-7087063896) · [Current onboarding deployment](https://github.com/mitchelldawkinsjr/launch-and-own/issues/2#issuecomment-7117559538)

1. Invite an independent, consenting customer (not the owner's existing test account). Obtain permission before logging non-secret evidence. Use a disposable, generated one-page site owned by the independent tester so both launch and edit can be tested in the same run. The tester connects **their own** GitHub and Cloudflare through provider consent pages; nobody pastes tokens into chats or issue comments.
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

## Stage C — approved update and production verification

The hosted editor is available for eligible generated one-page sites with a live launch in **Your launches**. The independent tester can use the site they launched in Stage B. The deployed code still needs a real, approved edit walkthrough. [#31](https://github.com/mitchelldawkinsjr/launch-and-own/pull/31) · [Deployment evidence](https://github.com/mitchelldawkinsjr/launch-and-own/issues/21#issuecomment-7088943293)

1. From the live launch, choose **Update this website**, make one visible headline change, and choose **Preview website changes**. Open **See exactly how it will look**. Record the starting GitHub SHA and exact preview SHA-256 from **Technical details**.
2. The tester chooses **Approve this update** after reviewing that exact preview. Verify the product creates a branch and GitHub PR with the approved homepage bytes. The owner's approval here authorizes the PR.
3. The tester reviews the PR and its checks and explicitly merges it in GitHub. Record the **merge commit SHA** reported by GitHub and the check results. If the test repo has no configured checks, record that and the result of independently comparing the PR homepage bytes to the approved digest.
4. Return to **Update status** and wait for the canonical production deployment of the merged SHA and matching public HTML digest. Record the result alongside the deployment ID. The original and new public HTML digests must differ.
5. Record any blocked, declined, or stale review and any retries or assistance. Share tester-approved evidence and keep credentials, private account identifiers, and private review URLs in the authorized test record.

**Remaining acceptance:** A consenting independent tester completes both stages and records the evidence below. Owner B13 and the owner ZIP test establish owner-only evidence. Run the one-page launch and update with optional services and public PR previews disabled. [Coordination in #2](https://github.com/mitchelldawkinsjr/launch-and-own/issues/2)

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
