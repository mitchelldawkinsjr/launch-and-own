/** Non-secret hosted assistant bootstrap state (migration 0015). Never stores KEK or PEM. */
const STEPS = new Set(['consent', 'cf_grant', 'create', 'access', 'github_app', 'install', 'ready', 'failed']);
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const SHA = /^[a-f0-9]{40}$/i;
const ORIGIN = /^https:\/\/[a-z0-9.-]+(?::\d+)?$/i;

function toRow(r) {
  if (!r) return null;
  let createdThisRun = [];
  try { createdThisRun = JSON.parse(r.created_this_run_json || '[]'); } catch { createdThisRun = []; }
  if (!Array.isArray(createdThisRun)) createdThisRun = [];
  return Object.freeze({
    jobId: r.job_id,
    githubUserId: r.github_user_id,
    cloudflareAccountId: r.cloudflare_account_id,
    siteSlug: r.site_slug,
    runId: r.run_id,
    step: r.step,
    assistantRepo: r.assistant_repo || null,
    workerName: r.worker_name || null,
    d1Id: r.d1_id || null,
    workerOrigin: r.worker_origin || null,
    upstreamSha: r.upstream_sha || null,
    createdThisRun,
    errorCode: r.error_code || null,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  });
}

export function assistantBootstrapEnabled(env) {
  return env?.OPTION_ASSISTANT_BOOTSTRAP_ENABLED === 'true';
}

export function createAssistantBootstrapStore(env, current) {
  const owner = [current.github_user_id, current.cloudflare_account_id];
  const scope = 'job_id = ? AND github_user_id = ? AND cloudflare_account_id = ?';
  return Object.freeze({
    async read(jobId) {
      if (typeof jobId !== 'string' || !jobId) return null;
      return toRow(await env.DB.prepare(
        'SELECT * FROM onboarding_assistant_bootstrap WHERE ' + scope
      ).bind(jobId, ...owner).first());
    },
    async start({ jobId, siteSlug, runId, upstreamSha }) {
      if (typeof jobId !== 'string' || !jobId || !SLUG.test(siteSlug || '') ||
          typeof runId !== 'string' || !runId || !SHA.test(upstreamSha || '')) return null;
      const time = Math.floor(Date.now() / 1000);
      await env.DB.prepare(
        'INSERT INTO onboarding_assistant_bootstrap ' +
        '(job_id, github_user_id, cloudflare_account_id, site_slug, run_id, step, upstream_sha, created_at, updated_at) ' +
        'VALUES (?,?,?,?,?,?,?,?,?) ' +
        'ON CONFLICT(job_id) DO NOTHING'
      ).bind(jobId, ...owner, siteSlug, runId, 'consent', upstreamSha, time, time).run();
      return this.read(jobId);
    },
    async advance(jobId, { step, assistantRepo, workerName, d1Id, workerOrigin, createdThisRun, errorCode } = {}) {
      if (!STEPS.has(step)) return null;
      const time = Math.floor(Date.now() / 1000);
      const sets = ['step = ?', 'updated_at = ?'];
      const values = [step, time];
      if (typeof assistantRepo === 'string' && assistantRepo) {
        sets.push('assistant_repo = COALESCE(assistant_repo, ?)');
        values.push(assistantRepo);
      }
      if (typeof workerName === 'string' && workerName) {
        sets.push('worker_name = COALESCE(worker_name, ?)');
        values.push(workerName);
      }
      if (typeof d1Id === 'string' && UUID.test(d1Id)) {
        sets.push('d1_id = COALESCE(d1_id, ?)');
        values.push(d1Id);
      }
      if (typeof workerOrigin === 'string' && ORIGIN.test(workerOrigin)) {
        sets.push('worker_origin = COALESCE(worker_origin, ?)');
        values.push(workerOrigin);
      }
      if (Array.isArray(createdThisRun)) {
        sets.push('created_this_run_json = ?');
        values.push(JSON.stringify(createdThisRun));
      }
      if (step === 'failed' && typeof errorCode === 'string') {
        sets.push('error_code = ?');
        values.push(errorCode.slice(0, 80));
      } else if (step !== 'failed') {
        sets.push('error_code = NULL');
      }
      await env.DB.prepare(
        'UPDATE onboarding_assistant_bootstrap SET ' + sets.join(', ') + ' WHERE ' + scope
      ).bind(...values, jobId, ...owner).run();
      const saved = await this.read(jobId);
      if (!saved || saved.step !== step) return null;
      return saved;
    }
  });
}
