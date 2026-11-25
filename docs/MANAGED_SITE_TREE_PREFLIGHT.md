# Safe GitHub tree preflight for managed-site update proposals (#39)

**Implementation model: GPT-6. Status: code-only review foundation; no hosted write or production deployment.**

A customer editing their website after launch history expires must not inadvertently overwrite a Git symlink, submodule, folder, or changed file. The merged #98/103/112 foundation can verify owned-site source and sidecar bytes and construct a **review-only** proposal, but does not yet authorize the next customer-approved GitHub branch/PR.

`pipeline/managed-site-tree-preflight.mjs` exports `preflightManagedSiteUpdateTree({currentSource,sidecarEvidence,reviewPlan,mainBranch,pinnedCommit,pinnedTree,trustedReviewDigest})`. This is a **pure verifier**: it calls no providers, creates no branch, makes no D1 changes, never returns customer HTML, and cannot grant consent.

## Required authenticated input

The eventual Domain backend must obtain all inputs from the **current** authenticated customer session, under live authorization-epoch checks and an immutable owner/repository/Pages binding. Inputs cannot come from browser JSON or model output:

- `currentSource`: exact SHA-pinned source already verified with #98.
- `sidecarEvidence`: present/absent sidecar, tied to the same site/commit and exact Git blob, from #112. For updates, the existing content SHA-256 must match #103's review.
- `reviewPlan`: the `status:'review_required'`, non-writable preview returned by merged #103, built from an independently verified generated one-page site or separately approved owner adoption. The helper enforces only the expected paths and bytes, **not** original site provenance, consent or rights.
- `trustedReviewDigest`: the exact proposed review digest from a **server-sealed, current-session and epoch-bound review record**, not an untrusted form field. Equality to a digest string does not itself confer approval.
- `mainBranch`: fresh GitHub `GET /repos/{owner}/{repo}/branches/main` response.
- `pinnedCommit`: authenticated GitHub `GET /repos/{owner}/{repo}/git/commits/{expectedBaseSha}` response.
- `pinnedTree`: authenticated GitHub `GET /repos/{owner}/{repo}/git/trees/{commit.tree.sha}?recursive=1` response. The backend must query the verified, private repository, never a user-selected path or repository.

The branch head SHA must equal the approved current source SHA, the commit must be the same SHA, and the returned full tree SHA must equal `commit.tree.sha`. A truncated tree or malformed/duplicated path is **not** a partial success. The verifier caps the input tree at 4096 entries, requiring an independently reviewed path for larger repositories. The helper snapshots all inputs synchronously before hashing and refuses changes to the originals during async work.

## Tree rules

The approved **sidecar-only migration** changes exactly `.launch-and-own/site-config.json`. It requires the current homepage to be the unchanged regular `100644` blob with the exact original Git blob SHA, and the sidecar to be **absent** from the pinned Git tree. An existing `.launch-and-own` parent is allowed only if it is a real Git tree, never a symlink or file.

The approved **structured edit** changes exactly `public/index.html` and `.launch-and-own/site-config.json` together. Both must exist as ordinary regular `100644` blobs and match the original pinned homepage/sidecar Git blob IDs. A changed homepage, deleted sidecar, same-name directory or wrong parent type refuses the proposal. The resulting HTML and sidecar bytes must each hash exactly to #103's SHA-256 proposed digests.

Other repository files are not to be rewritten. Git tree rows are checked for canonical, non-duplicated paths, expected mode/type pairs, valid Git SHAs and completeness. The helper explicitly refuses symlinks (120000), executable substitutions, gitlinks/submodules (160000), folder replacements, and descendants placed under a target file.

**No-op or unsupported/custom/multipage/ZIP updates are not accepted by this helper.** A no-op must be handled without starting any PR. The #103 planner already rejects unsupported generated-site and arbitrary custom HTML editing.

## Output and release gates

Passing returns:

```json
{
  "status": "tree_review_preflight_passed",
  "siteId": "managed_42_pinned-project",
  "expectedBaseCommitSha": "40 lowercase hex digits",
  "expectedTreeSha": "40 lowercase hex digits",
  "reviewDigest": "64 lowercase hex digits",
  "proposedPaths": ["public/index.html", ".launch-and-own/site-config.json"],
  "fileModesChecked": true,
  "fullTreeChecked": true,
  "requiresSeparateHumanApproval": true,
  "readyForProviderWrite": false,
  "publicationVerified": false
}
```

This proves only *consistency of supplied GitHub tree evidence and review bytes*. It cannot prove the provider data is authentic without the backend current-owner and private-provider read gates. It is **not** an authorization to write and never automatically creates a customer branch or PR. Immediately before an eventual reviewed mutation, the executor must independently recheck unchanged branch SHA, exact owner/repository/project IDs, current session/grants and explicit consent/review expiry; it must stage only the approved private feature branch and PR, not `main`.

No production, OAuth permission, billing, Cloudflare, DNS, database, or website content changes occur in this work. This does not constitute independent customer acceptance (#21), a deployed editor, or historical provenance proof. The existing hosted editor and UI are owned under #30/#2; coordination with Sol #83 is required before any integration.

## Verification and rollback

Tests cover migration/paired edits, regular-file modes, wrong blob IDs, symlink/submodule/directory collisions, stale main/commit/tree, truncated/oversized trees, invalid/duplicate paths, wrong site/sidecar evidence, tampered review digest or proposed bytes and asynchronous input mutation. Run `npm test`, `npm run qa:distribution`, `npm run preflight:onboarding`, Worker syntax and Worker/D1 recovery CI.

Rollback is a Git revert of these three independent files; no resource data or permission is changed. **Model: GPT-6 (OpenAI).**
