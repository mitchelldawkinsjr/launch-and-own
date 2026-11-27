import assert from 'node:assert/strict';
import test from 'node:test';
import { IMPORTED_EDITING_MILESTONE } from './index.mjs';
import { EVAL_CASES, meetsEvalThreshold, referenceOutputs, scoreCandidate, unevaluatedCandidateReport } from './eval.mjs';
import { CANDIDATE_MODELS, FREE_ALLOCATION, PAID_BILLING_REQUIRED, verifyCandidateModels } from './models.mjs';

const liveCatalog = () => ({
  neuronsPerDay: 10000,
  models: [...CANDIDATE_MODELS.map(model => model.id), '@cf/zai-org/glm-5.3-flash'],
  paidBillingRequired: [...PAID_BILLING_REQUIRED]
});

test('scores the fixed eval set for schema-valid and correct edits', async () => {
  const outputs = await referenceOutputs();
  const perfect = await scoreCandidate('@cf/ibm-granite/granite-4.0-h-micro', outputs);
  assert.equal(perfect.cases, EVAL_CASES.length);
  assert.equal(perfect.schemaValidPercent, 100);
  assert.equal(perfect.correctPercent, 100);
  assert.equal(meetsEvalThreshold(perfect), true);

  const wrong = { ...outputs };
  const headline = JSON.parse(wrong['unique-headline']);
  headline.edits[0].replace = 'Other Name';
  wrong['unique-headline'] = JSON.stringify(headline);
  const partial = await scoreCandidate('@cf/zai-org/glm-4.7-flash', wrong);
  assert.equal(partial.schemaValidPercent, 100);
  assert.ok(partial.correctPercent < 100);
  assert.equal(meetsEvalThreshold(partial), false);

  const invalid = Object.fromEntries(EVAL_CASES.map(item => [item.id, '{"shell":"rm -rf"}']));
  const rejected = await scoreCandidate('@cf/openai/gpt-oss-20b', invalid);
  assert.equal(rejected.schemaValidPercent, 0);
  assert.equal(rejected.correctPercent, 0);
  assert.equal(rejected.results.every(result => result.schemaValid === false), true);
});

test('checks candidate model names and the shared free allocation against a catalog snapshot', () => {
  const verified = verifyCandidateModels(liveCatalog());
  assert.deepEqual(verified.map(model => model.id), CANDIDATE_MODELS.map(model => model.id));
  assert.equal(verified.every(model => model.freeAllocationEligible && model.verified), true);
  assert.equal(FREE_ALLOCATION.neuronsPerDay, 10000);
  assert.equal(FREE_ALLOCATION.checkedOn, '2026-11-24');

  const missing = liveCatalog();
  missing.models = missing.models.filter(id => id !== '@cf/openai/gpt-oss-20b');
  assert.throws(() => verifyCandidateModels(missing), /candidate-model-not-eligible/);

  const paid = liveCatalog();
  paid.paidBillingRequired = [...paid.paidBillingRequired, '@cf/ibm-granite/granite-4.0-h-micro'];
  assert.throws(() => verifyCandidateModels(paid), /candidate-model-not-eligible/);

  assert.throws(() => verifyCandidateModels({ ...liveCatalog(), neuronsPerDay: 0 }), /model-catalog-unverified/);
  const pending = unevaluatedCandidateReport(CANDIDATE_MODELS);
  assert.equal(pending.every(row => row.executed === false && row.schemaValidPercent === null), true);
});

test('keeps imported editing unreleased after the hosted routes are wired', () => {
  assert.equal(IMPORTED_EDITING_MILESTONE.hostedWorkerWiring, 'routed');
  assert.equal(IMPORTED_EDITING_MILESTONE.releaseAccess, 'not_available');
  assert.equal(IMPORTED_EDITING_MILESTONE.slice, 'ws1-ws3-hosted-routes-visual-editor');
  assert.equal(IMPORTED_EDITING_MILESTONE.liveWorker, 'launch-and-own-onboarding-beta');
  assert.equal(IMPORTED_EDITING_MILESTONE.liveVersion, 'b31ee9eb-a86a-4e2e-bdb7-4358ee8b3ca5');
  assert.equal(IMPORTED_EDITING_MILESTONE.liveBase, '35a5f8d9fc0432af3dd19b3a1c07e57d500740ba');
  assert.equal(IMPORTED_EDITING_MILESTONE.livePinned, false);
});
