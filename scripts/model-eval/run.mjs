// Manual: scores the candidate Workers AI models on imported/eval.mjs EVAL_CASES using the product prompt
// (buildModelRequest). Start the scratch Worker first: `cd scripts/model-eval && npx wrangler dev --remote --port 8811`.
// Uses the Workers AI allowance of the account wrangler is logged into (about 25k tokens per full run).
import {writeFileSync} from 'node:fs';
import {EVAL_CASES, meetsEvalThreshold, scoreCandidate} from '../../imported/eval.mjs';
import {buildModelRequest, retrieveSnippets} from '../../imported/snippets.mjs';
import {inspectSite} from '../../imported/intelligence.mjs';
import {CANDIDATE_MODELS} from '../../imported/models.mjs';

const endpoint = process.argv[2] || 'http://localhost:8811';
const REQUEST = '00000000-0000-4000-8000-000000000001';
const text = out => typeof out?.response === 'string' ? out.response
  : out?.response && typeof out.response === 'object' ? JSON.stringify(out.response)
  : out?.choices?.[0]?.message?.content ?? '';
// Models may wrap the JSON in prose or code fences; score the outermost object.
const extract = raw => { const a = raw.indexOf('{'), b = raw.lastIndexOf('}'); return a >= 0 && b > a ? raw.slice(a, b + 1) : raw; };
const report = [];
// EVAL_MODELS=id1,id2 scores other models without changing the product's CANDIDATE_MODELS list.
const models = process.env.EVAL_MODELS ? process.env.EVAL_MODELS.split(',').map(id => ({id})) : CANDIDATE_MODELS;
for (const model of models) {
  const outputs = {};
  let tokens = 0;
  for (const item of EVAL_CASES) {
    const files = item.files.map(f => ({path: f.path, bytes: f.bytes}));
    const inspection = await inspectSite(files);
    const req = buildModelRequest({baseCommitSha: item.baseCommitSha, instruction: item.instruction, requestId: REQUEST, repositoryId: 101,
      snippets: retrieveSnippets(item.files, {maxSnippets: 8, maxBytes: 8192, window: 2000}),
      capabilities: {files: inspection.files.map(f => ({path: f.path, blobSha: f.blobSha, editable: f.editable, readOnlyReason: f.readOnlyReason}))}});
    const res = await fetch(endpoint, {method: 'POST', body: JSON.stringify({model: model.id,
      messages: [{role: 'system', content: req.system}, {role: 'user', content: JSON.stringify(req.user)}]})});
    const out = await res.json();
    tokens += out?.usage?.total_tokens ?? 0;
    outputs[item.id] = extract(out.error ? '' : text(out));
  }
  const scored = await scoreCandidate(model.id, outputs);
  report.push({model: model.id, schemaValidPercent: scored.schemaValidPercent, correctPercent: scored.correctPercent,
    meetsThreshold: meetsEvalThreshold(scored), tokens, failed: scored.results.filter(r => !r.correct).map(r => r.id)});
  console.log(model.id, scored.schemaValidPercent + '% valid', scored.correctPercent + '% correct', tokens + ' tokens');
}
writeFileSync(new URL('./last-report.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
