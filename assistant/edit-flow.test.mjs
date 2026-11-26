// M2 slice 2 end-to-end tests (mocks only): owner request -> preview -> review -> approve -> PR, through the real Worker.
// IDs refer to docs/design/personal-assistant/m2-test-plan.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { accessKeyCache } from './access.mjs';
import { csrfToken, handle } from './worker.mjs';
import { base64Decode, base64Encode, gitBlobSha } from '../imported/bytes.mjs';

const TEAM = 'team.cloudflareaccess.com', AUD = 'a'.repeat(64), OWNER = 'owner-sub-1', ORIGIN = 'https://assistant.willow.test';
// Real clock: the shared library's approval expiry checks use Date.now(), as production does.
const T0 = Date.now();
const b64url = buf => Buffer.from(buf).toString('base64url');
const enc = s => new TextEncoder().encode(s);
const ghKey = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });

const SITE = {
  'public/index.html': '<!doctype html><html><head><link rel="stylesheet" href="styles.css"><title>Willow</title></head><body><h1>Willow Studio</h1><p>Saturday: 9 AM-2 PM</p><p><a href="mailto:hello@willow.example">Email</a></p></body></html>',
  'public/contact.html': '<!doctype html><html><head><title>Contact</title></head><body><h1>Contact Willow Studio</h1><p>Call 616-555-0100</p></body></html>',
  'public/about.html': '<!doctype html><html><head><title>About</title></head><body>' + ['one','two','three','four','five','six','seven','eight'].map(n => '<p>Fact ' + n + '</p>').join('') + '</body></html>',
  'public/styles.css': ':root { --brand: #336699; }\nbody { color: var(--brand); }\n',
  'README.md': '# site\n'
};

function fakeGitHub({ repoId = 101 } = {}) {
  const sha1 = s => createHash('sha1').update(s).digest('hex');
  const blobs = new Map(), trees = new Map(), commits = new Map();
  const state = { history: [], refs: new Map(), pulls: [], main: null, tokenBodies: [] };
  return (async () => {
    const entries = [{ path: 'public', mode: '040000', type: 'tree', sha: '2'.repeat(40) }];
    for (const [path, text] of Object.entries(SITE)) { const sha = await gitBlobSha(enc(text)); blobs.set(sha, enc(text)); entries.push({ path, mode: '100644', type: 'blob', sha }); }
    const baseTree = sha1('tree0'); trees.set(baseTree, entries);
    state.main = sha1('commit0'); commits.set(state.main, { tree: baseTree, parent: null });
    const root = '/repos/tester/esp-willow', json = (d, s = 200) => Response.json(d, { status: s });
    state.fetchFn = async (url, init = {}) => {
      const method = init.method || 'GET', u = new URL(url), path = decodeURIComponent(u.pathname), body = init.body ? JSON.parse(init.body) : null;
      if (u.hostname === TEAM) return json({ keys: [state.accessJwk] });
      state.history.push({ method, path, body });
      assert.equal(u.hostname, 'api.github.com');
      if (path === '/user') throw Error('installation tokens cannot call /user');
      if (path.startsWith(root + '/pulls/') && path.endsWith('/merge') && method === 'PUT') {
        const p = state.pulls.find(x => x.number === Number(path.split('/').at(-2)));
        state.merges = (state.merges || []).concat([body]);
        if (state.denyMerge || !p || body.sha !== p.head.sha) return json({ message: 'not mergeable' }, 405);
        Object.assign(p, { state: 'closed', merged: true, merged_at: '2026-11-26T12:00:00Z', merge_commit_sha: '9'.repeat(40) });
        return json({ merged: true, sha: '9'.repeat(40) });
      }
      if (path.includes('/merge')) throw Error('unexpected merge route');
      if (path === '/app/installations/2002/access_tokens') { state.tokenBodies.push(body); return json({ token: 'ghs_test', repositories: [{ id: repoId }], permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' } }, 201); }
      if (path === root && method === 'GET') return json({ id: repoId, name: 'esp-willow', private: true, default_branch: 'main', description: 'Launch & Own managed site: willow', owner: { login: 'tester', id: 42 } });
      if (path === root + '/branches/main') return json({ commit: { sha: state.main } });
      if (path.startsWith(root + '/git/commits/') && method === 'GET') { const sha = path.split('/').pop(); const c = commits.get(sha); return c ? json({ sha, tree: { sha: c.tree } }) : json({}, 404); }
      if (path.startsWith(root + '/git/trees/') && method === 'GET') { const t = trees.get(path.split('/').pop()); return t ? json({ truncated: false, tree: t }) : json({}, 404); }
      if (path.startsWith(root + '/git/blobs/') && method === 'GET') { const sha = path.split('/').pop(), b = blobs.get(sha); return b ? json({ sha, encoding: 'base64', content: base64Encode(b) }) : json({}, 404); }
      if (path.startsWith(root + '/git/ref/heads/') && method === 'GET') { const r = state.refs.get(path.slice((root + '/git/ref/heads/').length)); return r ? json({ object: { sha: r, type: 'commit' } }) : json({}, 404); }
      if (path === root + '/git/refs' && method === 'POST') { assert.match(body.ref, /^refs\/heads\/launch-and-own\/edit-[0-9a-f]{20}$/); state.refs.set(body.ref.slice(11), body.sha); return json({}, 201); }
      if (path.startsWith(root + '/git/refs/heads/') && method === 'PATCH') { state.refs.set(path.slice((root + '/git/refs/heads/').length), body.sha); return json({ object: { sha: body.sha } }); }
      if (path === root + '/git/blobs' && method === 'POST') { const b = base64Decode(body.content), sha = await gitBlobSha(b); blobs.set(sha, b); return json({ sha }, 201); }
      if (path === root + '/git/trees' && method === 'POST') {
        const next = trees.get(body.base_tree).map(e => ({ ...e, ...(body.tree.find(c => c.path === e.path) || {}) }));
        const sha = sha1(JSON.stringify(next)); trees.set(sha, next); return json({ sha }, 201);
      }
      if (path === root + '/git/commits' && method === 'POST') { const sha = sha1(JSON.stringify(body)); commits.set(sha, { tree: body.tree, parent: body.parents[0] }); return json({ sha }, 201); }
      if (path.startsWith(root + '/commits/')) {
        const sha = path.split('/').pop(), c = commits.get(sha), before = trees.get(commits.get(c.parent).tree), after = trees.get(c.tree);
        const files = after.filter(e => e.type === 'blob' && before.find(b => b.path === e.path).sha !== e.sha).map(e => ({ filename: e.path, status: 'modified', sha: e.sha }));
        return json({ sha, parents: [{ sha: c.parent }], commit: { tree: { sha: c.tree } }, files });
      }
      if (path === root + '/pulls' && method === 'GET') return json(state.pulls);
      if (path === root + '/pulls' && method === 'POST') {
        assert.match(body.body, /does not merge/);
        const pull = { number: state.pulls.length + 7, state: 'open', html_url: 'https://github.com/tester/esp-willow/pull/' + (state.pulls.length + 7), head: { ref: body.head, sha: state.refs.get(body.head), repo: { id: repoId } }, base: { ref: 'main', sha: state.main, repo: { id: repoId } } };
        state.pulls.push(pull); return json(pull, 201);
      }
      if (path.startsWith(root + '/pulls/')) { const p = state.pulls.find(x => x.number === Number(path.split('/').pop())); return p ? json(p) : json({}, 404); }
      throw Error('unexpected ' + method + ' ' + path);
    };
    state.moveMain = () => { const sha = sha1('moved'); commits.set(sha, { tree: baseTree, parent: state.main }); state.main = sha; };
    state.blobText = async path => new TextDecoder().decode(blobs.get(trees.get(commits.get(state.refs.get([...state.refs.keys()][0])).tree).find(e => e.path === path).sha));
    return state;
  })();
}

async function world({ ai, envExtra = {} } = {}) {
  const gh = await fakeGitHub();
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  gh.accessJwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'k1' };
  const clock = { t: T0 };
  const token = async () => {
    const input = b64url(JSON.stringify({ alg: 'RS256', kid: 'k1' })) + '.' + b64url(JSON.stringify({ iss: 'https://' + TEAM, aud: [AUD], sub: OWNER, exp: clock.t / 1000 + 3600, nbf: clock.t / 1000 - 10 }));
    return input + '.' + b64url(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, enc(input)));
  };
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('./migrations/0001_assistant.sql', import.meta.url), 'utf8'));
  const DB = { raw: db, prepare: sql => ({ bind: (...a) => ({ first: async () => db.prepare(sql).get(...a) || null, run: async () => db.prepare(sql).run(...a), all: async () => ({ results: db.prepare(sql).all(...a) }) }) }) };
  const aiCalls = [];
  const env = {
    ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, OWNER_SUB: OWNER, ASSISTANT_ORIGIN: ORIGIN, KEK: 'k'.repeat(32), DB,
    WEBSITE_OWNER: 'tester', WEBSITE_REPO: 'esp-willow', WEBSITE_REPO_ID: '101', GH_APP_ID: '1001', GH_INSTALLATION_ID: '2002', GH_APP_PRIVATE_KEY: ghKey.privateKey,
    ...(ai ? { AI_EDITS: 'on', AI: { run: async (model, input) => { aiCalls.push({ model, input }); return ai(input); } } } : {}), ...envExtra
  };
  const cache = accessKeyCache({ fetchFn: gh.fetchFn, now: () => clock.t });
  const csrf = await csrfToken(env, OWNER);
  const call = async (path, { method = 'GET', form } = {}) => handle(new Request(ORIGIN + path, {
    method, headers: { 'cf-access-jwt-assertion': await token(), ...(method === 'POST' ? { origin: ORIGIN } : {}) },
    body: form ? new URLSearchParams({ csrf, ...form }) : undefined
  }), env, { fetchFn: gh.fetchFn, now: () => clock.t, cache });
  const loc = res => { assert.equal(res.status, 303, 'expected redirect'); return res.headers.get('location'); };
  const hidden = (html, name) => new RegExp('name="' + name + '" value="([^"]+)"').exec(html)?.[1].replace(/&amp;/g, '&');
  return { gh, env, db, clock, call, loc, hidden, aiCalls };
}

const writes = gh => gh.history.filter(h => h.method !== 'GET');

test('happy path: typed edit -> preview -> review -> exact file -> Approve and publish -> one PR merged at the approved head, never /user', async () => {
  const w = await world();
  const home = await (await w.call('/')).text();
  assert.match(home, /Preview this edit/);
  assert.doesNotMatch(home, /Or describe it/, 'AI path off by default');
  const repoWrites = () => writes(w.gh).filter(h => !h.path.endsWith('/access_tokens'));
  const beforePreview = repoWrites().length;
  const review = w.loc(await w.call('/preview', { method: 'POST', form: { mode: 'typed', kind: 'text', old: 'Saturday: 9 AM-2 PM', replacement: 'Saturday: 10 AM-4 PM' } }));
  assert.match(review, /^\/review\?ticket=/);
  assert.equal(repoWrites().length, beforePreview, 'no GitHub writes before approval');
  const page = await (await w.call(review)).text();
  assert.match(page, /Saturday: 10 AM-4 PM/);
  assert.match(page, /Approve and publish/);
  assert.match(page, /Open a pull request instead/);
  const fileRes = await w.call('/file?ticket=' + encodeURIComponent(w.hidden(page, 'ticket')) + '&path=index.html');
  assert.equal(fileRes.status, 200);
  assert.match(fileRes.headers.get('content-security-policy'), /style-src 'self' 'unsafe-inline'/);
  assert.match(fileRes.headers.get('content-security-policy'), /script-src 'none'/);
  assert.match(await fileRes.text(), /Saturday: 10 AM-4 PM/);
  const form = { ticket: w.hidden(page, 'ticket'), approvalId: w.hidden(page, 'approvalId'), proposalDigest: w.hidden(page, 'proposalDigest'), artifactDigest: w.hidden(page, 'artifactDigest'), action: 'publish' };
  const status = w.loc(await w.call('/approve', { method: 'POST', form }));
  assert.equal(w.gh.merges.length, 1, 'Approve and publish merges once');
  assert.equal(w.gh.merges[0].sha, w.gh.pulls[0].head.sha, 'exactly the approved head');
  assert.match(status, /^\/pr\?ticket=/);
  assert.equal(w.gh.pulls.length, 1);
  assert.match(await w.gh.blobText('public/index.html'), /Saturday: 10 AM-4 PM/);
  assert.equal(await w.gh.blobText('public/contact.html'), SITE['public/contact.html'], 'unrelated files byte-identical');
  assert.deepEqual(w.gh.tokenBodies.at(-1), { repository_ids: [101], permissions: { contents: 'write', pull_requests: 'write' } });
  const claim = w.db.prepare('SELECT owner_provider, owner_id FROM onboarding_imported_edit_approvals').get();
  assert.deepEqual({ ...claim }, { owner_provider: 'cloudflare_access', owner_id: OWNER }, 'approval bound to the Access owner');
  const statusPage = await (await w.call(status)).text();
  assert.match(statusPage, /Published: merged into your website/);
  assert.match(statusPage, /pull\/7/);
});

test('T-SHA-1: main moves after the preview -> stale_base, no branch or commit', async () => {
  const w = await world();
  const review = w.loc(await w.call('/preview', { method: 'POST', form: { mode: 'typed', kind: 'text', old: 'Saturday: 9 AM-2 PM', replacement: 'Saturday: 10 AM-4 PM' } }));
  const page = await (await w.call(review)).text();
  w.gh.moveMain();
  const res = await w.call('/approve', { method: 'POST', form: { ticket: w.hidden(page, 'ticket'), approvalId: w.hidden(page, 'approvalId'), proposalDigest: w.hidden(page, 'proposalDigest'), artifactDigest: w.hidden(page, 'artifactDigest') } });
  assert.match(await res.text(), /changed since this preview/);
  assert.equal(writes(w.gh).filter(h => !h.path.endsWith('/access_tokens')).length, 0);
});

test('T-SHA-3 / T-RET-2: replaying an approval is refused and makes no second commit', async () => {
  const w = await world();
  const page = await (await w.call(w.loc(await w.call('/preview', { method: 'POST', form: { mode: 'typed', kind: 'text', old: 'Saturday: 9 AM-2 PM', replacement: 'Saturday: 10 AM-4 PM' } })))).text();
  const form = { ticket: w.hidden(page, 'ticket'), approvalId: w.hidden(page, 'approvalId'), proposalDigest: w.hidden(page, 'proposalDigest'), artifactDigest: w.hidden(page, 'artifactDigest'), action: 'pr' };
  w.loc(await w.call('/approve', { method: 'POST', form }));
  assert.equal((w.gh.merges || []).length, 0, 'the pull-request choice never merges');
  const commitsBefore = writes(w.gh).filter(h => h.path.endsWith('/git/commits')).length;
  const replay = await w.call('/approve', { method: 'POST', form });
  assert.match(await replay.text(), /already used/);
  assert.equal(writes(w.gh).filter(h => h.path.endsWith('/git/commits')).length, commitsBefore);
  assert.equal(w.gh.pulls.length, 1);
});

test('tickets are sealed, owner-bound and expire after 15 minutes; mismatched digests are refused', async () => {
  const w = await world();
  const page = await (await w.call(w.loc(await w.call('/preview', { method: 'POST', form: { mode: 'typed', kind: 'text', old: 'Saturday: 9 AM-2 PM', replacement: 'Saturday: 10 AM-4 PM' } })))).text();
  const ticket = w.hidden(page, 'ticket');
  const tampered = ticket.slice(0, 10) + (ticket[10] === 'A' ? 'B' : 'A') + ticket.slice(11);
  assert.match(await (await w.call('/review?ticket=' + encodeURIComponent(tampered))).text(), /does not match the preview/);
  assert.match(await (await w.call('/approve', { method: 'POST', form: { ticket, approvalId: w.hidden(page, 'approvalId'), proposalDigest: 'f'.repeat(64), artifactDigest: w.hidden(page, 'artifactDigest') } })).text(), /does not match/);
  w.clock.t += 16 * 60 * 1000;
  assert.match(await (await w.call('/review?ticket=' + encodeURIComponent(ticket))).text(), /expired/);
  assert.equal(w.gh.pulls.length, 0);
});

test('text on more than one page asks which page; a given page file narrows it', async () => {
  const w = await world();
  const res = await w.call('/preview', { method: 'POST', form: { mode: 'typed', kind: 'text', old: 'Willow Studio', replacement: 'River Studio' } });
  const html = await res.text();
  assert.equal(res.status, 400);
  assert.match(html, /more than one page/);
  assert.match(w.loc(await w.call('/preview', { method: 'POST', form: { mode: 'typed', kind: 'text', old: 'Willow Studio', replacement: 'River Studio', path: 'index.html' } })), /^\/review/);
});

test('T-INJ-2: a typed script injection is escaped, never inserted as markup', async () => {
  const w = await world();
  const page = await (await w.call(w.loc(await w.call('/preview', { method: 'POST', form: { mode: 'typed', kind: 'text', old: 'Saturday: 9 AM-2 PM', replacement: '<script>alert(1)</script>' } })))).text();
  const file = await (await w.call('/file?ticket=' + encodeURIComponent(w.hidden(page, 'ticket')) + '&path=index.html')).text();
  assert.doesNotMatch(file, /<script>alert/);
  assert.match(file, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

const aiProposal = edits => input => {
  const user = JSON.parse(input.messages[1].content);
  return { response: JSON.stringify({ v: 1, requestId: user.requestId, repositoryId: user.repositoryId, baseCommitSha: user.baseCommitSha, summary: 'Update hours', edits: edits(user) }) };
};
const hoursEdit = user => { const f = user.capabilities.files.find(x => x.path === 'public/index.html'); return [{ kind: 'text', path: 'public/index.html', expectedBlobSha: f.blobSha, find: 'Saturday: 9 AM-2 PM', replace: 'Saturday: 10 AM-4 PM' }]; };

test('AI path (opt-in): budget reserved before the call, proposal validated, then the same review flow', async () => {
  const w = await world({ ai: aiProposal(hoursEdit) });
  assert.match(await (await w.call('/')).text(), /Or describe it/);
  const aiPreview = await w.call('/preview', { method: 'POST', form: { mode: 'ai', request: 'Open Saturdays 10 to 4' } });
  if (aiPreview.status !== 303) throw new Error(await aiPreview.text());
  const review = aiPreview.headers.get('location');
  assert.match(await (await w.call(review)).text(), /Saturday: 10 AM-4 PM/);
  assert.equal(w.aiCalls.length, 1);
  const { AI_REQUEST_NEURONS, DEFAULT_AI_MODEL } = await import('./edit-flow.mjs');
  assert.equal(w.db.prepare('SELECT neurons FROM assistant_usage').get().neurons, AI_REQUEST_NEURONS);
  assert.equal(w.aiCalls[0].model, DEFAULT_AI_MODEL);
  assert.equal(DEFAULT_AI_MODEL, '@cf/openai/gpt-oss-120b');
  assert.equal(JSON.stringify(w.aiCalls[0]).includes('ghs_test'), false, 'no credentials reach the model');
  assert.equal(JSON.stringify(w.aiCalls[0]).includes('kkkkkkkk'), false);
});

test('T-QUO-1: when the daily budget is used up the model is never called', async () => {
  const w = await world({ ai: aiProposal(hoursEdit), envExtra: { DAILY_NEURON_BUDGET: '100' } });
  const res = await w.call('/preview', { method: 'POST', form: { mode: 'ai', request: 'Open Saturdays 10 to 4' } });
  assert.match(await res.text(), /AI allowance for the assistant is used up/);
  assert.equal(w.aiCalls.length, 0);
});

test('T-INJ-1/4: model output that targets non-site files or is invalid is refused before any preview', async () => {
  for (const bad of [
    () => [{ kind: 'text', path: '.github/workflows/x.yml', expectedBlobSha: 'a'.repeat(40), find: 'on', replace: 'off' }],
    () => [{ kind: 'link', path: 'public/index.html', expectedBlobSha: 'a'.repeat(40), find: 'mailto:hello@willow.example', replace: 'javascript:alert(1)' }]
  ]) {
    const w = await world({ ai: aiProposal(bad) });
    const res = await w.call('/preview', { method: 'POST', form: { mode: 'ai', request: 'do it' } });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /Nothing was changed/);
  }
  const w = await world({ ai: () => ({ response: 'I cannot help with that.' }) });
  assert.match(await (await w.call('/preview', { method: 'POST', form: { mode: 'ai', request: 'do it' } })).text(), /could not turn that request into a safe change/);
});

test('AI mode is refused when the owner has not turned it on', async () => {
  const w = await world();
  const res = await w.call('/preview', { method: 'POST', form: { mode: 'ai', request: 'Open Saturdays 10 to 4' } });
  assert.equal(res.status, 400);
});

test('a ticket sealed for one owner is refused for another, and for another step', async () => {
  const { sealTicket, openTicket } = await import('./edit-flow.mjs');
  const env = { KEK: 'k'.repeat(32) };
  const t = await sealTicket(env, 'review', 'owner-a', { x: 1 }, Date.now());
  assert.equal((await openTicket(env, 'review', 'owner-a', t, Date.now())).x, 1);
  await assert.rejects(openTicket(env, 'review', 'owner-b', t, Date.now()), /approval_mismatch/);
  await assert.rejects(openTicket(env, 'status', 'owner-a', t, Date.now()), /approval_mismatch/);
  await assert.rejects(openTicket({ KEK: 'z'.repeat(32) }, 'review', 'owner-a', t, Date.now()), /approval_mismatch/);
});

test('a wrong pinned repository id is refused before any GitHub write', async () => {
  const w = await world({ envExtra: { WEBSITE_REPO_ID: '999' } });
  const res = await w.call('/preview', { method: 'POST', form: { mode: 'typed', kind: 'text', old: 'Saturday: 9 AM-2 PM', replacement: 'Saturday: 10 AM-4 PM' } });
  assert.notEqual(res.status, 303);
  assert.equal(writes(w.gh).filter(h => !h.path.endsWith('/access_tokens')).length, 0);
});

test('an AI proposal too large for a review ticket fails clearly as too large', async () => {
  const big = user => {
    const sha = user.capabilities.files.find(x => x.path === 'public/about.html').blobSha;
    return ['one','two','three','four','five','six','seven','eight'].map(n => ({ kind: 'text', path: 'public/about.html', expectedBlobSha: sha, find: 'Fact ' + n, replace: n + ' ' + 'x'.repeat(480) }));
  };
  const w = await world({ ai: aiProposal(big) });
  const res = await w.call('/preview', { method: 'POST', form: { mode: 'ai', request: 'long' } });
  assert.match(await res.text(), /too large/);
});

test('Approve and publish: a merge GitHub refuses leaves the PR open with an explanation', async () => {
  const w = await world();
  const page = await (await w.call(w.loc(await w.call('/preview', { method: 'POST', form: { mode: 'typed', kind: 'text', old: 'Saturday: 9 AM-2 PM', replacement: 'Saturday: 10 AM-4 PM' } })))).text();
  w.gh.denyMerge = true;
  const status = w.loc(await w.call('/approve', { method: 'POST', form: { ticket: w.hidden(page, 'ticket'), approvalId: w.hidden(page, 'approvalId'), proposalDigest: w.hidden(page, 'proposalDigest'), artifactDigest: w.hidden(page, 'artifactDigest') } }));
  assert.equal(w.gh.merges.length, 1, 'no choice means publish');
  const statusPage = await (await w.call(status)).text();
  assert.match(statusPage, /GitHub did not allow an automatic merge/);
  assert.match(statusPage, /open for you to review and merge/);
});
