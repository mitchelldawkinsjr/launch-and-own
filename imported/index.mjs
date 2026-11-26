export { ImportedEditError } from './errors.mjs';
export { inspectSite } from './intelligence.mjs';
export { editablePages, listEditTargets, pickEditTarget } from './targets.mjs';
export { readCurrentRevision } from './revision.mjs';
export { buildModelRequest, retrieveSnippets } from './snippets.mjs';
export { parseModelOutput, unrelatedFilesIdentical, validateEdits } from './edits.mjs';
export { CANDIDATE_MODELS, FREE_ALLOCATION, verifyCandidateModels } from './models.mjs';
export { EVAL_CASES, meetsEvalThreshold, referenceOutputs, scoreCandidate, unevaluatedCandidateReport } from './eval.mjs';
export { isolatePreview, previewCredentialKeys, previewResponse } from './preview.mjs';
export { bindApproval } from './approval.mjs';
export { proposeImportedPullRequest, readImportedPullRequest } from './pull-request.mjs';
export { assessPublishedRevision, verifyPublishedRevision } from './verify-published.mjs';

// Hosted routes are wired. The live upload below is not this commit.
// Release access stays not_available until orchestration reviews the release
// matrix and an owner-live edit is recorded.
export const IMPORTED_EDITING_MILESTONE = Object.freeze({
  slice: 'ws1-ws3-hosted-routes',
  hostedWorkerWiring: 'routed',
  releaseAccess: 'not_available',
  liveWorker: 'launch-and-own-onboarding-beta',
  liveVersion: 'b31ee9eb-a86a-4e2e-bdb7-4358ee8b3ca5',
  liveBase: '35a5f8d9fc0432af3dd19b3a1c07e57d500740ba',
  livePinned: false,
  reason: 'Cloudflare version b31ee9eb was uploaded from uncommitted files on 35a5f8d. This commit is ahead of that upload. Availability stays not_available until orchestration reviews the release matrix and an owner-live edit is recorded.'
});
