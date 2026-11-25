import { ImportedEditError } from './errors.mjs';

// Checked against https://developers.cloudflare.com/workers-ai/platform/pricing/ on 2026-11-24.
// Free allocation is 10,000 Neurons per day, shared by the account, then paid usage begins.
// These three candidates are priced on that page and are not in the paid-billing-required note.
export const FREE_ALLOCATION = Object.freeze({
  neuronsPerDay: 10000,
  resets: '00:00 UTC',
  source: 'https://developers.cloudflare.com/workers-ai/platform/pricing/',
  checkedOn: '2026-11-24'
});

export const CANDIDATE_MODELS = Object.freeze([
  Object.freeze({
    id: '@cf/ibm-granite/granite-4.0-h-micro',
    label: 'Granite 4.0 H Micro',
    freeAllocationEligible: true,
    inputUsdPerMillion: 0.017,
    outputUsdPerMillion: 0.112
  }),
  Object.freeze({
    id: '@cf/zai-org/glm-4.7-flash',
    label: 'GLM 4.7 Flash',
    freeAllocationEligible: true,
    inputUsdPerMillion: 0.06,
    outputUsdPerMillion: 0.4
  }),
  Object.freeze({
    id: '@cf/openai/gpt-oss-20b',
    label: 'GPT-OSS 20B',
    freeAllocationEligible: true,
    inputUsdPerMillion: 0.2,
    outputUsdPerMillion: 0.3
  })
]);

export const PAID_BILLING_REQUIRED = Object.freeze([
  '@cf/moonshotai/kimi-k2.6',
  '@cf/moonshotai/kimi-k2.7-code',
  '@cf/zai-org/glm-5.2',
  '@cf/zai-org/glm-5.3',
  '@cf/zai-org/glm-5.3-flash',
  '@cf/deepseek-ai/deepseek-v4-flash-0731',
  '@cf/deepseek-ai/deepseek-v4.1-flash-1017',
  '@cf/deepseek-ai/deepseek-v4-pro-0813',
  '@cf/thinkingmachines/inkling-2-small'
]);

export function verifyCandidateModels(live) {
  if (!live || live.neuronsPerDay !== FREE_ALLOCATION.neuronsPerDay || !Array.isArray(live.models) || !Array.isArray(live.paidBillingRequired)) {
    throw new ImportedEditError('model-catalog-unverified');
  }
  const models = new Set(live.models);
  const paid = new Set(live.paidBillingRequired);
  for (const id of PAID_BILLING_REQUIRED) {
    if (!paid.has(id)) throw new ImportedEditError('paid-model-list-drift');
  }
  for (const candidate of CANDIDATE_MODELS) {
    if (!models.has(candidate.id) || paid.has(candidate.id) || candidate.freeAllocationEligible !== true) {
      throw new ImportedEditError('candidate-model-not-eligible');
    }
  }
  return CANDIDATE_MODELS.map(model => ({ id: model.id, label: model.label, freeAllocationEligible: true, verified: true }));
}
