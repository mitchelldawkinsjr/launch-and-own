import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import miniflare from 'miniflare';
import { sha256 } from '../../onboarding/crypto.mjs';
import {
  approvePreview, connectTenant, GENERATED_SHA, harness as nodeTestHarness, launchId,
  newPreview, origin, post, reviewDigest, writes
} from '../../onboarding/worker-test-support.mjs';

const { Miniflare, Response, convertV4MiniflareOptions } = miniflare;
const root = new URL('../../', import.meta.url);
const migrations = new URL('onboarding/migrations/', root);
const scheduledPath = '/__rehearsal/scheduled';
const cronExpression = '*/5 * * * *';

async function bundleWorker(outfile) {
  await build({
    stdin: {
      contents: `import worker from './onboarding/worker.mjs';
        export default {
          async fetch(request, env, context) {
            if (new URL(request.url).pathname === ${JSON.stringify(scheduledPath)}) {
              await worker.scheduled({cron: ${JSON.stringify(cronExpression)}}, env, context);
              return new Response(null, {status: 204});
            }
            return worker.fetch(request, env, context);
          }
        };`,
      resolveDir: fileURLToPath(root),
    },
    outfile, bundle: true, platform: 'node', format: 'esm',
  });
}

async function withRuntime(scriptPath, scenario, { loseRepositoryReply = false } = {}) {
  const config = JSON.parse(await readFile(new URL('onboarding/wrangler.jsonc', root), 'utf8'));
  // Reuse the Node suite's provider simulation. All Worker SQL uses Miniflare's D1.
  const { calls, fetchFn, resourceState, sqlite } = nodeTestHarness();
  let loseNextReply = loseRepositoryReply;
  const options = convertV4MiniflareOptions({
    modules: true,
    modulesRoot: dirname(scriptPath),
    scriptPath,
    compatibilityDate: config.compatibility_date,
    compatibilityFlags: config.compatibility_flags,
    d1Databases: { DB: 'local-recovery-rehearsal' },
    ratelimits: { ONBOARDING_LIMITER: { namespace_id: '2001', simple: { limit: 100, period: 60 } } },
    bindings: {
      ONBOARDING_ORIGIN: origin,
      TOKEN_ENCRYPTION_KEY: 'ab'.repeat(32),
      GH_CLIENT_ID: 'Iv1.example',
      GH_CLIENT_SECRET: 'local-fixture',
      CF_CLIENT_ID: 'local-cf-id',
      CF_CLIENT_SECRET: 'local-fixture',
      CF_SCOPES: config.vars.CF_SCOPES,
    },
    async outboundService(request) {
      // All Worker egress goes through the same provider fixture as the Node tests.
      if (new URL(request.url).hostname === 'api.github.com')
        assert.equal(request.headers.get('user-agent'), 'launch-and-own');
      const method = request.method;
      const body = request.body === null ? undefined : await request.text();
      const response = await fetchFn(request.url, { method, body });
      if (loseNextReply && method === 'POST' && request.url.endsWith('/user/repos')) {
        assert.equal(response.status, 201);
        loseNextReply = false;
        return new Response('Simulated reply lost after repository creation', { status: 503 });
      }
      return new Response(response.body === null ? null : await response.arrayBuffer(), {
        status: response.status, headers: [...response.headers],
      });
    },
  });

  let runtime;
  try {
    runtime = new Miniflare(options);
    const request = (path, { method = 'GET', cookie, body, headers } = {}) => runtime.dispatchFetch(origin + path, {
      method, body, redirect: 'manual',
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(method === 'POST' ? { origin, 'content-type': 'application/x-www-form-urlencoded' } : {}),
        ...headers,
      },
    });
    const db = await runtime.getD1Database('DB');
    const files = (await readdir(migrations)).filter(name => /^\d{4}_.+\.sql$/.test(name)).sort();
    assert(files.length > 0, 'Expected onboarding migrations');
    for (const file of files) {
      const sql = await readFile(new URL(file, migrations), 'utf8');
      await db.prepare(sql).run();
    }
    assert.equal((await (await request('/health')).json()).launchJobsReady, true);
    return await scenario({ db, request, calls, resourceState });
  } finally {
    try {
      await runtime?.dispose();
    } finally {
      sqlite.close();
    }
  }
}

function readJob(db, id) {
  return db.prepare(`SELECT id, status, error_code, expected_commit_sha, repository_id,
    pages_project_id, expires_at FROM onboarding_launch_jobs WHERE id = ?`).bind(id).first();
}

async function waitForJob(db, id, expected) {
  const deadline = Date.now() + 10000;
  let job;
  do {
    job = await readJob(db, id);
    if (job && Object.entries(expected).every(([field, value]) => job[field] === value)) return job;
    // The HTTP approval schedules work with waitUntil after returning the redirect.
    await delay(25);
  } while (Date.now() < deadline);
  assert.fail(`Recovery job did not reach ${JSON.stringify(expected)} (state ${job?.status}, code ${job?.error_code})`);
}

async function deliverCron(harness) {
  assert.equal((await harness.request(scheduledPath)).status, 204);
}

async function backoffElapsed(db, id) {
  // Advance the local fixture's due time to avoid waiting through production backoff.
  await db.prepare('UPDATE onboarding_launch_jobs SET next_attempt_at = 0 WHERE id = ?').bind(id).run();
}

async function previewHtml(harness, cookie, id) {
  const response = await harness.request('/site-preview?id=' + id, { cookie });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Willow Studio/);
  return html;
}

async function resumeAfterExpiry(harness) {
  const { db, calls, resourceState } = harness;
  const owner = await connectTenant(harness);
  const id = await newPreview(harness, owner);
  const approvedHtml = await previewHtml(harness, owner.cookie, id);
  const approval = { csrf: owner.csrf, id, digest: await reviewDigest(harness, owner.cookie, id) };
  const approvals = await Promise.all([
    post(harness, '/approve', owner.cookie, approval),
    post(harness, '/approve', owner.cookie, approval),
  ]);
  assert.equal(approvals.filter(response => response.status === 303).length, 1);
  assert(approvals.every(response => [303, 400, 409].includes(response.status)));
  await waitForJob(db, id, { status: 'queued', error_code: 'provider_unavailable' });
  assert.equal(await db.prepare('SELECT COUNT(*) AS n FROM onboarding_launch_jobs').first('n'), 1);
  assert.equal(await db.prepare('SELECT COUNT(*) AS n FROM onboarding_launch_job_sessions').first('n'), 1);
  assert.equal(resourceState.repo?.private, true);
  assert.equal(writes(harness).length, 1);
  const beforeBackoff = calls.length;
  await deliverCron(harness);
  assert.equal(calls.length, beforeBackoff);

  resourceState.publicHtml = '<html>Waiting for the approved homepage</html>';
  await backoffElapsed(db, id);
  await Promise.all([deliverCron(harness), deliverCron(harness)]);
  const checkpoint = await waitForJob(db, id, { status: 'pending_deployment' });
  assert.equal(checkpoint.expected_commit_sha, GENERATED_SHA);
  assert.equal(checkpoint.repository_id, 101);
  assert.equal(checkpoint.pages_project_id, 'pages-stable-101');
  assert.equal(writes(harness).filter(call => call.url.endsWith('/user/repos')).length, 1);
  assert.equal(writes(harness).filter(call => call.method === 'PUT').length, 1);
  assert.equal(writes(harness).filter(call => call.url.endsWith('/pages/projects')).length, 1);

  const originalSessionHash = await sha256(owner.cookie.split('=')[1]);
  await db.prepare('UPDATE onboarding_sessions SET expires_at = unixepoch() - 1 WHERE id_hash = ?')
    .bind(originalSessionHash).run();
  await backoffElapsed(db, id);
  const beforeExpiry = calls.length;
  await deliverCron(harness);
  assert.equal(calls.length, beforeExpiry);
  assert.equal((await readJob(db, id)).status, 'needs_reauthorization');
  assert.equal(await db.prepare('SELECT COUNT(*) AS n FROM onboarding_launch_job_sessions').first('n'), 0);
  assert.equal(await db.prepare('SELECT COUNT(*) AS n FROM onboarding_sessions WHERE id_hash = ?')
    .bind(originalSessionHash).first('n'), 0);

  const reconnected = await connectTenant(harness);
  const restored = await post(harness, '/restore', reconnected.cookie, { csrf: reconnected.csrf, id });
  assert.equal(restored.status, 303);
  const restoredId = launchId(restored);
  assert.notEqual(restoredId, id);
  assert.equal(await previewHtml(harness, reconnected.cookie, restoredId), approvedHtml);
  assert.equal(await db.prepare('SELECT COUNT(*) AS n FROM onboarding_launch_job_sessions').first('n'), 0);
  const beforeReapproval = calls.length;
  await deliverCron(harness);
  assert.equal(calls.length, beforeReapproval);
  assert.equal((await readJob(db, id)).status, 'needs_reauthorization');

  const deployment = resourceState.pages.canonical_deployment;
  deployment.deployment_trigger.metadata.commit_hash = 'b'.repeat(40);
  assert.equal((await approvePreview(harness, reconnected.cookie, reconnected.csrf, restoredId)).status, 303);
  await waitForJob(db, id, { status: 'pending_deployment', error_code: 'approved_deployment_pending' });

  deployment.deployment_trigger.metadata.commit_hash = checkpoint.expected_commit_sha;
  await backoffElapsed(db, id);
  await deliverCron(harness);
  await waitForJob(db, id, { status: 'pending_deployment', error_code: 'approved_html_not_served' });

  resourceState.publicHtml = approvedHtml;
  await backoffElapsed(db, id);
  await deliverCron(harness);
  const live = await waitForJob(db, id, { status: 'live' });
  assert.equal(live.expected_commit_sha, checkpoint.expected_commit_sha);
  assert.equal(live.repository_id, checkpoint.repository_id);
  assert.equal(live.pages_project_id, checkpoint.pages_project_id);
  assert.equal(live.expires_at, checkpoint.expires_at);
  assert.equal(writes(harness).length, 3);
  assert.equal(await db.prepare('SELECT COUNT(*) AS n FROM onboarding_launch_jobs').first('n'), 1);
}

async function rejectRevokedGrant(harness) {
  const owner = await connectTenant(harness);
  const id = await newPreview(harness, owner);
  assert.equal((await approvePreview(harness, owner.cookie, owner.csrf, id)).status, 303);
  const checkpoint = await waitForJob(harness.db, id, { status: 'pending_deployment' });
  const beforeRevocation = writes(harness).length;
  harness.resourceState.githubRevoked = true;
  await deliverCron(harness);
  const paused = await readJob(harness.db, id);
  assert.equal(paused.status, 'needs_reauthorization');
  assert.equal(paused.error_code, 'provider_authorization_required');
  assert.equal(paused.expected_commit_sha, checkpoint.expected_commit_sha);
  const afterRevocation = harness.calls.length;
  await deliverCron(harness);
  assert.equal(harness.calls.length, afterRevocation);
  assert.equal(writes(harness).length, beforeRevocation);
}

const scratch = await mkdtemp(join(tmpdir(), 'launch-own-recovery-'));
try {
  const scriptPath = join(scratch, 'worker.mjs');
  await bundleWorker(scriptPath);
  await withRuntime(scriptPath, resumeAfterExpiry, { loseRepositoryReply: true });
  await withRuntime(scriptPath, rejectRevokedGrant);
  console.log(JSON.stringify({
    mode: 'local-worker-d1',
    liveProviderRequests: 0,
    checks: {
      duplicateApproval: 'passed',
      ambiguousRepositoryReply: 'passed',
      overlappingCron: 'passed',
      sessionExpiry: 'passed',
      explicitReapproval: 'passed',
      pinnedDeployment: 'passed',
      providerRevocation: 'passed',
    },
  }, null, 2));
} finally {
  await rm(scratch, { recursive: true, force: true });
}
