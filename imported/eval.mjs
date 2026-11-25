import { encodeUtf8, gitBlobSha } from './bytes.mjs';
import { parseModelOutput, validateEdits } from './edits.mjs';
import { inspectSite } from './intelligence.mjs';

export const EVAL_THRESHOLDS = Object.freeze({ schemaValid: 0.95, correct: 0.90 });

const BASE = 'a'.repeat(40);

function file(path, text) {
  return { path, bytes: encodeUtf8(text) };
}

const page = (body) => `<!doctype html><html><head><title>Willow</title></head><body>${body}</body></html>`;

export const EVAL_CASES = Object.freeze([
  Object.freeze({
    id: 'unique-headline',
    baseCommitSha: BASE,
    instruction: 'Change the headline to River & Pine',
    files: Object.freeze([file('index.html', page('<h1>Willow Studio</h1><p>Family portraits.</p>'))]),
    expectedEdits: Object.freeze([{ kind: 'text', path: 'index.html', old: 'Willow Studio', new: 'River & Pine' }])
  }),
  Object.freeze({
    id: 'unique-link',
    baseCommitSha: BASE,
    instruction: 'Point the contact link at https://river.example/contact',
    files: Object.freeze([file('index.html', page('<a href="https://willow.example/contact">Contact</a>'))]),
    expectedEdits: Object.freeze([{ kind: 'link', path: 'index.html', old: 'https://willow.example/contact', new: 'https://river.example/contact' }])
  }),
  Object.freeze({
    id: 'business-email',
    baseCommitSha: BASE,
    instruction: 'Change the contact email to hello@river.example',
    files: Object.freeze([file('index.html', page('<p>Email hello@willow.example</p>'))]),
    expectedEdits: Object.freeze([{ kind: 'business_info', path: 'index.html', old: 'hello@willow.example', new: 'hello@river.example' }])
  }),
  Object.freeze({
    id: 'css-color',
    baseCommitSha: BASE,
    instruction: 'Change the custom property --ink from #1f4b3a to #8c3a2f',
    files: Object.freeze([
      file('index.html', page('<h1>Willow Studio</h1>')),
      file('styles.css', ':root { --ink: #1f4b3a; }\n')
    ]),
    expectedEdits: Object.freeze([{ kind: 'css_color', path: 'styles.css', old: '#1f4b3a', new: '#8c3a2f' }])
  }),
  Object.freeze({
    id: 'ambiguous-headline',
    baseCommitSha: BASE,
    instruction: 'Change Welcome to Hello',
    files: Object.freeze([file('index.html', page('<h1>Welcome</h1><p>Welcome</p>'))]),
    expectedEdits: Object.freeze([])
  }),
  Object.freeze({
    id: 'minified-script',
    baseCommitSha: BASE,
    instruction: 'Change the headline to River & Pine',
    files: Object.freeze([
      file('index.html', page('<h1>Willow Studio</h1><script src="assets/index-deadbeef.js"></script>')),
      file('assets/index-deadbeef.js', 'function(){' + 'var a=1;'.repeat(80) + '}')
    ]),
    expectedEdits: Object.freeze([])
  }),
  Object.freeze({
    id: 'unbuilt-framework',
    baseCommitSha: BASE,
    instruction: 'Change the headline to River & Pine',
    files: Object.freeze([
      file('package.json', '{"name":"site"}\n'),
      file('vite.config.js', 'export default {}\n'),
      file('src/App.jsx', 'export function App(){ return <h1>Willow Studio</h1> }\n'),
      file('index.html', page('<div id="root"></div>'))
    ]),
    expectedEdits: Object.freeze([])
  }),
  Object.freeze({
    id: 'hosting-config',
    baseCommitSha: BASE,
    instruction: 'Change the headline to River & Pine',
    files: Object.freeze([
      file('index.html', page('<h1>Willow Studio</h1>')),
      file('wrangler.toml', 'name = "site"\n')
    ]),
    expectedEdits: Object.freeze([])
  })
]);

function percent(count) {
  return Math.round((1000 * count) / EVAL_CASES.length) / 10;
}

function sameEdits(actual, expected) {
  if (actual.length !== expected.length) return false;
  return expected.every((edit, index) => actual[index].kind === edit.kind && actual[index].path === edit.path
    && actual[index].old === edit.old && actual[index].new === edit.new);
}

const REQUEST = '00000000-0000-4000-8000-000000000001';

export async function referenceOutputs() {
  const outputs = {};
  for (const item of EVAL_CASES) {
    const edits = [];
    for (const edit of item.expectedEdits) {
      const file = item.files.find(entry => entry.path === edit.path);
      edits.push({
        kind: edit.kind,
        path: 'public/' + edit.path,
        expectedBlobSha: await gitBlobSha(file.bytes),
        find: edit.old,
        replace: edit.new
      });
    }
    outputs[item.id] = JSON.stringify({
      v: 1,
      requestId: REQUEST,
      repositoryId: 101,
      baseCommitSha: item.baseCommitSha,
      summary: item.instruction.slice(0, 200),
      edits
    });
  }
  return outputs;
}

export async function scoreCandidate(modelId, outputs) {
  if (typeof modelId !== 'string' || !modelId) throw new Error('model id required');
  let schemaValid = 0;
  let correct = 0;
  const results = [];
  for (const item of EVAL_CASES) {
    let valid = false;
    let matched = false;
    try {
      const proposal = parseModelOutput(outputs?.[item.id]);
      const files = item.files.map(entry => ({ path: entry.path, bytes: entry.bytes }));
      const inspection = await inspectSite(files);
      const validated = await validateEdits({
        baseCommitSha: item.baseCommitSha, files, inspection, proposal, repositoryId: 101
      });
      valid = true;
      matched = sameEdits(validated.edits, item.expectedEdits);
    } catch {
      valid = false;
      matched = false;
    }
    if (valid) schemaValid += 1;
    if (matched) correct += 1;
    results.push({ id: item.id, schemaValid: valid, correct: matched });
  }
  return {
    model: modelId,
    executed: true,
    cases: EVAL_CASES.length,
    schemaValidPercent: percent(schemaValid),
    correctPercent: percent(correct),
    results
  };
}

export function meetsEvalThreshold(report) {
  return Boolean(report && report.executed === true
    && report.schemaValidPercent >= EVAL_THRESHOLDS.schemaValid * 100
    && report.correctPercent >= EVAL_THRESHOLDS.correct * 100);
}

export function unevaluatedCandidateReport(models) {
  return models.map(model => ({
    model: model.id,
    executed: false,
    schemaValidPercent: null,
    correctPercent: null,
    reason: 'live Workers AI calls stay unwired until the owner authorizes inference'
  }));
}
