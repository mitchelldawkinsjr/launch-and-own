import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  accessGuide, consentText, fillName, installGuide, newState, preflight, rollback, runProvision, saveState, statePath
} from './provision.mjs';

const SHA = 'a'.repeat(40);

test('fillName and consent copy stay customer-owned and pause for Access and App install', () => {
  assert.equal(fillName('{owner}/{siteSlug}-assistant', { owner: 'tester', siteSlug: 'willow' }), 'tester/willow-assistant');
  const text = consentText({
    owner: 'tester', siteSlug: 'willow', websiteRepo: 'tester/esp-willow', workersPlan: 'free', email: 'a@example.com'
  });
  assert.match(text, /Launch & Own does not receive access/);
  assert.match(text, /pause twice/);
  assert.doesNotMatch(text, /free forever/i);
  assert.match(accessGuide({ siteSlug: 'willow', origin: 'https://assistant.example.com' }), /Access application/);
  assert.match(installGuide({ appSlug: 'willow-assistant', websiteRepo: 'tester/esp-willow' }), /Only select repositories/);
});

test('preflight refuses old Node and bad inputs', async () => {
  const adapters = {
    nodeVersion: () => '20.0.0',
    whoami: async () => 'ok',
    listD1: async () => []
  };
  assert.equal((await preflight({
    siteSlug: 'willow', websiteRepo: 'tester/esp-willow', upstreamSha: SHA
  }, adapters)).ok, false);

  adapters.nodeVersion = () => '22.12.0';
  assert.equal((await preflight({
    siteSlug: 'Bad_Slug', websiteRepo: 'tester/esp-willow', upstreamSha: SHA
  }, adapters)).ok, false);

  const ok = await preflight({
    siteSlug: 'willow', websiteRepo: 'tester/esp-willow', upstreamSha: SHA
  }, adapters);
  assert.equal(ok.ok, true);
  assert.equal(ok.report.d1Count, 0);
});

test('dry-run walks every step, writes resume state without secrets, and rollback deletes only this-run resources', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lo-provision-'));
  const calls = [];
  const adapters = {
    nodeVersion: () => '22.12.0',
    whoami: async () => 'account tester',
    listD1: async () => [],
    createD1: async (name) => { calls.push(['createD1', name]); return { name, id: 'db-1' }; },
    migrateD1: async (name) => { calls.push(['migrateD1', name]); },
    deploy: async () => { calls.push(['deploy']); },
    secretPut: async (name) => { calls.push(['secretPut', name]); },
    deleteD1: async (name) => { calls.push(['deleteD1', name]); },
    deleteWorker: async (name) => { calls.push(['deleteWorker', name]); },
    deleteRepo: async (name) => { calls.push(['deleteRepo', name]); },
    healthz: async () => ({ status: 200, body: 'ok' }),
    selfCheck: async () => ({ status: 200, body: '{"access":"ok"}' }),
    ensureRepo: async () => ({ name: 'tester/willow-assistant', created: true }),
    writeWranglerVars: async () => {},
    runManifestExchange: async () => ({ appId: 99, slug: 'willow-assistant', secretSaved: true })
  };

  try {
    const first = await runProvision({
      siteSlug: 'willow', owner: 'tester', websiteRepo: 'tester/esp-willow',
      upstreamSha: SHA, email: 'a@example.com', workersPlan: 'free',
      origin: 'https://assistant.example.com'
    }, { adapters, dryRun: true, stateDir: dir, prompt: async () => 'YES' });

    assert.equal(first.state.steps.preflight.status, 'done');
    assert.equal(first.state.steps['self-check'].status, 'done');
    assert.deepEqual(calls, [], 'dry-run creates no provider resources');
    const saved = JSON.parse(await readFile(first.path, 'utf8'));
    assert.equal(saved.runId, first.state.runId);
    assert.doesNotMatch(JSON.stringify(saved), /KEK|pem|BEGIN/);

    // Simulate a failed live run that created resources, then roll them back.
    const live = newState({
      siteSlug: 'willow', owner: 'tester', websiteRepo: 'tester/esp-willow', upstreamSha: SHA, runId: 'run-live'
    });
    live.createdThisRun = [
      { id: 'assistant-repo', name: 'tester/willow-assistant' },
      { id: 'd1', name: 'lo-assistant-willow' },
      { id: 'worker', name: 'lo-assistant-willow' }
    ];
    const report = await rollback(live, adapters);
    assert.deepEqual(report, [
      'deleted worker lo-assistant-willow',
      'deleted d1 lo-assistant-willow',
      'deleted repo tester/willow-assistant'
    ]);
    assert.deepEqual(calls, [
      ['deleteWorker', 'lo-assistant-willow'],
      ['deleteD1', 'lo-assistant-willow'],
      ['deleteRepo', 'tester/willow-assistant']
    ]);

    // Resume a waiting access step without redoing earlier work.
    const waiting = newState({
      siteSlug: 'willow', owner: 'tester', websiteRepo: 'tester/esp-willow', upstreamSha: SHA, runId: 'run-wait'
    });
    waiting.steps.preflight = { status: 'done' };
    waiting.steps.repo = { status: 'done' };
    waiting.steps.d1 = { status: 'done' };
    waiting.steps.worker = { status: 'done' };
    waiting.steps.access = { status: 'waiting' };
    const waitPath = statePath(dir, waiting.runId);
    await saveState(waitPath, waiting);
    const answers = ['team.example.com', 'aud-1', 'owner-sub'];
    const resumed = await runProvision({
      siteSlug: 'willow', owner: 'tester', websiteRepo: 'tester/esp-willow',
      upstreamSha: SHA, origin: 'https://assistant.example.com'
    }, {
      adapters: {
        ...adapters,
        deploy: async () => { calls.push(['redeploy']); },
        writeWranglerVars: async (vars) => { calls.push(['vars', vars.ACCESS_TEAM_DOMAIN]); },
        runManifestExchange: async () => ({ appId: 1, slug: 'willow-assistant', secretSaved: true }),
        secretPut: async (name) => { calls.push(['secret', name]); }
      },
      resumePath: waitPath,
      prompt: async () => answers.shift() || '1'
    });
    assert.equal(resumed.state.steps.access.status, 'done');
    assert.equal(resumed.state.steps['self-check'].status, 'done');
    assert.ok(calls.some(c => c[0] === 'redeploy'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
