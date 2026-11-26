// M2 slice 3 tests (mocks only): customer-run GitHub App setup and the A2 update channel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_PERMISSIONS, buildManifest, setupHandler } from './setup/manifest-exchange.mjs';
import { compareVersions, decideUpdate, parseReleaseInfo, verifyRelease } from './update/check-update.mjs';
import { affectedBelow, updateCheck } from './update/run-update-check.mjs';

const PEM = '-----BEGIN RSA PRIVATE KEY-----\nSECRETKEYMATERIAL\n-----END RSA PRIVATE KEY-----';
const STATE = 'f'.repeat(32), PORT = 8790, HOST = '127.0.0.1:' + PORT;

function setup({ status = 201, app } = {}) {
  const secrets = [], calls = [];
  const fetchFn = async (url, init) => { calls.push({ url: String(url), init }); return Response.json(app ?? { id: 77, slug: 'willow-assistant', pem: PEM, client_id: 'Iv1', client_secret: 'CLIENTSECRET', webhook_secret: null }, { status }); };
  const handler = setupHandler({ name: 'willow-assistant', origin: 'https://assistant.willow.test', repo: 'owner/willow-site', port: PORT, fetchFn, state: STATE, writeSecret: async (n, v) => secrets.push([n, v]) });
  return { handler, secrets, calls };
}

test('manifest requests only contents/pull_requests write and metadata read, private, webhooks off, local redirect', () => {
  const m = buildManifest({ name: 'willow-assistant', origin: 'https://assistant.willow.test', port: PORT });
  assert.deepEqual(m.default_permissions, APP_PERMISSIONS);
  assert.deepEqual(Object.keys(m.default_permissions).sort(), ['contents', 'metadata', 'pull_requests']);
  assert.equal(m.public, false);
  assert.equal(m.hook_attributes.active, false);
  assert.deepEqual(m.default_events, []);
  assert.equal(m.redirect_url, 'http://127.0.0.1:8790/callback');
  assert.throws(() => buildManifest({ name: 'Bad Name', origin: 'https://x.test', port: PORT }));
  assert.throws(() => buildManifest({ name: 'ok-name', origin: 'http://x.test', port: PORT }));
});

test('T-BOOT-1..3: the code is exchanged once, the key goes only to the secret writer, client_secret is discarded', async () => {
  const { handler, secrets, calls } = setup();
  const out = await handler({ method: 'GET', url: '/callback?code=abcdef123456&state=' + STATE, host: HOST });
  assert.equal(out.status, 200);
  assert.deepEqual(secrets, [['GH_APP_PRIVATE_KEY', PEM]]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.github.com/app-manifests/abcdef123456/conversions');
  assert.equal(calls[0].init.headers.authorization, undefined, 'conversion sends no credentials');
  assert.doesNotMatch(out.body + JSON.stringify(out.result), /SECRETKEYMATERIAL|CLIENTSECRET|abcdef123456/);
  assert.deepEqual(out.result, { appId: 77, slug: 'willow-assistant', secretSaved: true });
  const replay = await handler({ method: 'GET', url: '/callback?code=abcdef123456&state=' + STATE, host: HOST });
  assert.equal(replay.status, 400);
  assert.equal(calls.length, 1, 'never retried');
});

test('setup refuses a wrong state, a foreign Host (DNS rebinding) and a failed conversion without writing secrets', async () => {
  const s1 = setup();
  assert.equal((await s1.handler({ method: 'GET', url: '/callback?code=abcdef123456&state=' + 'e'.repeat(32), host: HOST })).status, 400);
  assert.equal((await s1.handler({ method: 'GET', url: '/', host: 'evil.test:' + PORT })).status, 421);
  const s2 = setup({ status: 404 });
  assert.equal((await s2.handler({ method: 'GET', url: '/callback?code=abcdef123456&state=' + STATE, host: HOST })).status, 502);
  assert.deepEqual([...s1.secrets, ...s2.secrets], []);
});

test('the start page escapes the manifest and posts to GitHub with the state', async () => {
  const { handler } = setup();
  const out = await handler({ method: 'GET', url: '/', host: 'localhost:' + PORT });
  assert.match(out.body, /action="https:\/\/github\.com\/settings\/apps\/new\?state=f{32}"/);
  assert.doesNotMatch(out.body, /value="\{"/, 'JSON is attribute-escaped');
});

const rel = (version, cls, extra = {}) => ({ version, class: cls, minSupportedFrom: '0.1.0', ...extra });
const NOW = Date.UTC(2026, 10, 26);

test('A2: PR only for security, breaking, advisory or end-of-support; fix/feature is a notice (T-UPD-7, T-UPD-9)', () => {
  assert.equal(compareVersions('0.10.0', '0.9.9') > 0, true);
  assert.deepEqual(decideUpdate({ running: '0.2.0', releases: [rel('0.2.0', 'fix')], now: NOW }), { action: 'none', reasons: [] });
  assert.equal(decideUpdate({ running: '0.1.0', releases: [rel('0.1.1', 'fix'), rel('0.2.0', 'feature')], now: NOW }).action, 'notice');
  const sec = decideUpdate({ running: '0.1.0', releases: [rel('0.1.1', 'security'), rel('0.2.0', 'feature')], now: NOW });
  assert.equal(sec.action, 'pr'); assert.equal(sec.target, '0.2.0', 'goes to the latest verified release');
  assert.equal(decideUpdate({ running: '0.1.0', releases: [rel('0.2.0', 'breaking')], now: NOW }).action, 'pr');
  assert.deepEqual(decideUpdate({ running: '0.1.0', releases: [rel('0.1.1', 'fix')], advisories: [{ id: 'GHSA-x', affectedBelow: '0.1.1' }], now: NOW }).reasons, ['advisory:GHSA-x']);
  assert.equal(decideUpdate({ running: '0.1.0', releases: [rel('0.1.1', 'fix')], advisories: [{ id: 'GHSA-y', affectedBelow: '0.1.0' }], now: NOW }).action, 'notice', 'advisory does not cover running version');
  const eos = rel('0.3.0', 'feature', { endOfSupport: [{ below: '0.2.0', date: '2027-01-15' }] });
  assert.equal(decideUpdate({ running: '0.1.0', releases: [eos], now: NOW }).action, 'pr', 'within 90 days');
  assert.equal(decideUpdate({ running: '0.1.0', releases: [eos], now: Date.UTC(2026, 6, 1) }).action, 'notice', 'more than 90 days out');
  assert.equal(decideUpdate({ running: '0.1.0', releases: [rel('0.3.0', 'feature', { minSupportedFrom: '0.2.0' })], now: NOW }).action, 'pr');
  assert.equal(affectedBelow('< 0.4.2'), '0.4.2'); assert.equal(affectedBelow('>= 0.1.0, < 0.4.2'), undefined);
});

test('release.json is strictly parsed: unknown keys, wrong tag, bad class or dates make it unusable (T-UPD-8)', () => {
  assert.ok(parseReleaseInfo(rel('0.2.0', 'fix'), 'v0.2.0'));
  for (const [value, tag] of [[rel('0.2.0', 'fix'), 'v0.2.1'], [rel('0.2.0', 'urgent'), 'v0.2.0'], [{ ...rel('0.2.0', 'fix'), notes: 'security!' }, 'v0.2.0'],
    [rel('0.2.0', 'fix', { endOfSupport: [{ below: '0.1.0', date: 'soon' }] }), 'v0.2.0'], [null, 'v0.2.0']]) assert.equal(parseReleaseInfo(value, tag), null);
});

const attestation = sha => JSON.stringify([{ verificationResult: { statement: { predicate: { buildDefinition: { resolvedDependencies: [{ digest: { gitCommit: sha } }] } } } } }]);
const upstream = { repository: 'up/assistant', signerWorkflow: '.github/workflows/release.yml' };

test('T-UPD-2/6: provenance gate needs both release attestations and the signer-workflow attestation', async () => {
  const calls = [];
  const okRun = async (cmd, args) => { calls.push(args); return args[0] === 'attestation' ? attestation('a'.repeat(40)) : ''; };
  const ok = await verifyRelease({ tag: 'v0.2.0', tarballPath: 't', releaseJsonPath: 'r', releaseJson: rel('0.2.0', 'security'), upstream, run: okRun });
  assert.deepEqual(ok, { info: rel('0.2.0', 'security'), commitSha: 'a'.repeat(40) });
  assert.deepEqual(calls.at(-1), ['attestation', 'verify', 't', '--repo', 'up/assistant', '--signer-workflow', 'up/assistant/.github/workflows/release.yml', '--format', 'json']);
  for (const failAt of ['t', 'r', 'attestation']) {
    const run = async (cmd, args) => { if (args.includes(failAt)) throw Error('verify failed'); return args[0] === 'attestation' ? attestation('a'.repeat(40)) : ''; };
    assert.equal(await verifyRelease({ tag: 'v0.2.0', tarballPath: 't', releaseJsonPath: 'r', releaseJson: rel('0.2.0', 'security'), upstream, run }), null, failAt);
  }
  const twoCommits = async (cmd, args) => args[0] === 'attestation' ? JSON.stringify([...JSON.parse(attestation('a'.repeat(40))), ...JSON.parse(attestation('b'.repeat(40)))]) : '';
  assert.equal(await verifyRelease({ tag: 'v0.2.0', tarballPath: 't', releaseJsonPath: 'r', releaseJson: rel('0.2.0', 'security'), upstream, run: twoCommits }), null);
});

async function repoFixture(running) {
  const root = await mkdtemp(join(tmpdir(), 'assistant-repo-'));
  await mkdir(join(root, 'assistant'), { recursive: true });
  await writeFile(join(root, 'assistant/UPSTREAM.json'), JSON.stringify(upstream));
  await writeFile(join(root, 'assistant/VERSION'), running + '\n');
  return root;
}
function fakeGh({ releaseJson, existingPr = false }) {
  const calls = [];
  const run = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === 'gh' && args[0] === 'api' && args[1].includes('/releases')) return JSON.stringify(['v0.2.0']);
    if (cmd === 'gh' && args[0] === 'api' && args[1].includes('security-advisories')) return '[]';
    if (cmd === 'gh' && args[0] === 'release' && args[1] === 'download') { await writeFile(join(args.at(-1), 'release.json'), JSON.stringify(releaseJson)); return ''; }
    if (cmd === 'gh' && args[0] === 'attestation') return attestation('c'.repeat(40));
    if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list') return existingPr ? '[{"number":3}]' : '[]';
    return '';
  };
  return { run, calls };
}

test('orchestrator: security release opens exactly one labelled PR, excludes workflow files, and is idempotent', async () => {
  const root = await repoFixture('0.1.0');
  const { run, calls } = fakeGh({ releaseJson: rel('0.2.0', 'security') });
  const out = await updateCheck({ root, run, now: NOW, log: () => {} });
  assert.equal(out.action, 'pr');
  const tar = calls.find(c => c[0] === 'tar');
  assert.ok(tar.includes('--exclude=*/.github/workflows/*'));
  assert.equal(calls.filter(c => c[1] === 'pr' && c[2] === 'create').length, 1);
  const create = calls.find(c => c[2] === 'create');
  assert.ok(create.some(a => /\(security\)$/.test(a)), 'label carried in the title');
  assert.equal(create.includes('--label'), false, 'labels may not exist in a fresh repo');
  assert.equal(await readFile(join(root, 'assistant/UPSTREAM_SHA'), 'utf8'), 'c'.repeat(40) + '\n', 'SHA from attestation, not notes');
  assert.equal(calls.some(c => c.join(' ').includes('pr review') || c.join(' ').includes('pr merge')), false, 'never approves or merges');
  const again = fakeGh({ releaseJson: rel('0.2.0', 'security'), existingPr: true });
  assert.equal((await updateCheck({ root: await repoFixture('0.1.0'), run: again.run, now: NOW, log: () => {} })).action, 'exists');
});

test('orchestrator: a feature release only writes a notice; no branch, no PR', async () => {
  const root = await repoFixture('0.1.0');
  const summary = join(root, 'summary.md');
  const { run, calls } = fakeGh({ releaseJson: rel('0.2.0', 'feature') });
  assert.equal((await updateCheck({ root, run, now: NOW, log: () => {}, summary })).action, 'notice');
  assert.match(await readFile(summary, 'utf8'), /0\.2\.0 is available/);
  assert.equal(calls.some(c => c[0] === 'git' || c[2] === 'create'), false);
});

test('a failed secret write keeps the app id, tells the owner how to recover, and never shows the key', async () => {
  const handler = setupHandler({ name: 'willow-assistant', origin: 'https://assistant.willow.test', repo: 'owner/willow-site', port: PORT, state: STATE,
    fetchFn: async () => Response.json({ id: 77, slug: 'willow-assistant', pem: PEM, client_secret: 'CLIENTSECRET' }, { status: 201 }),
    writeSecret: async () => { throw Error('wrangler failed'); } });
  const out = await handler({ method: 'GET', url: '/callback?code=abcdef123456&state=' + STATE, host: HOST });
  assert.equal(out.status, 500);
  assert.deepEqual(out.result, { appId: 77, slug: 'willow-assistant', secretSaved: false });
  assert.match(out.body, /generate a new private key/);
  assert.doesNotMatch(out.body, /SECRETKEYMATERIAL|CLIENTSECRET/);
});

test('an unreadable advisory feed does not stop a security release PR', async () => {
  const root = await repoFixture('0.1.0');
  const base = fakeGh({ releaseJson: rel('0.2.0', 'security') });
  const run = async (cmd, args) => { if (cmd === 'gh' && args[1]?.includes('security-advisories')) throw Error('403'); return base.run(cmd, args); };
  assert.equal((await updateCheck({ root, run, now: NOW, log: () => {} })).action, 'pr');
});
