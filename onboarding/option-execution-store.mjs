// #88: trusted D1 bridge between stored customer reviews and operator-approved work.
// This module never grants its own approvals. No browser values can create an
// 'approved' row. An operator must authorize the exact immutable snapshot out
// of band before this store can claim an action.
import {isApprovedFormsMutation} from '../pipeline/forms-provider-plan.mjs';
import {createFormsCostPrivacyGate} from './forms-cost-privacy-store.mjs';
import {createD1FormsProvisioningStore} from './forms-provisioning-store.mjs';
import { hasCurrentOwnerSession, isLaunchId } from './launch-jobs.mjs';
import { readOwnedStoredOptionApproval } from './stored-option-approvals.mjs';

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const SHA = /^[a-f0-9]{40}$/i;
const ACCOUNT = /^[a-f0-9]{32}$/i;
const clean = s => typeof s === 'string' ? s.toLowerCase() : '';
const stamp = () => Math.floor(Date.now() / 1000);
const denied = () => {throw Error('The separately authorized option execution is unavailable');};

export function isOptionExecutionConfigured(env) {
  // Exact explicit release switches: legacy stored requests stay review-only.
  return env?.OPTION_EXECUTION_ENABLED === 'true' && !!env.DB;
}
export async function optionExecutionSchemaReady(db) {
  try {
    await db.prepare('SELECT id, option_approval_id, status FROM onboarding_option_executions LIMIT 0').all();
    return true;
  } catch { return false; }
}

function sameSnapshot(execution, reviewed, current) {
  const site = reviewed.currentSite;
  return execution &&
    UUID.test(execution.id || '') && UUID.test(execution.option_approval_id || '') &&
    execution.option_approval_id === reviewed.id &&
    execution.job_id === reviewed.jobId && execution.kind === reviewed.kind &&
    execution.github_user_id === reviewed.githubUserId &&
    execution.cloudflare_account_id === reviewed.cloudflareAccountId &&
    execution.approval_digest === reviewed.digest &&
    execution.payload_json === JSON.stringify(reviewed.normalizedPayload) &&
    execution.repository_id === site.repositoryId &&
    execution.pages_project_id === site.pagesProjectId &&
    execution.expected_commit_sha === site.expectedCommitSha &&
    execution.authorization_epoch === current.authorization_epoch &&
    typeof execution.operator_grant_id === 'string' && execution.operator_grant_id.length >= 8 &&
    Number.isSafeInteger(execution.approved_at) &&
    Number.isSafeInteger(execution.expires_at) &&
    execution.expires_at > stamp() && execution.expires_at > execution.approved_at;
}

function owned(current, principal) {
  return !!current && Number.isSafeInteger(current.github_user_id) &&
    current.github_user_id === principal.githubUserId &&
    clean(current.github_login) === clean(principal.githubLogin) &&
    ACCOUNT.test(current.cloudflare_account_id || '') &&
    current.cloudflare_account_id === principal.cloudflareAccountId &&
    typeof current.hash === 'string' &&
    Number.isSafeInteger(current.authorization_epoch);
}

const CURRENT_EXECUTION = String.raw`
  SELECT x.* FROM onboarding_option_executions x
  JOIN onboarding_launch_jobs j ON j.id = x.job_id
  JOIN onboarding_option_approvals o ON o.id = x.option_approval_id
  WHERE x.id = ? AND x.github_user_id = ? AND x.cloudflare_account_id = ?
    AND x.authorization_epoch = ? AND x.status = 'approved'
    AND x.expires_at > ? AND x.job_id = o.job_id
    AND x.github_user_id = o.github_user_id AND x.cloudflare_account_id = o.cloudflare_account_id
    AND x.kind = o.kind AND x.approval_digest = o.approval_digest
    AND o.status = 'stored'
    AND j.status = 'live' AND j.expires_at > ?
    AND j.github_user_id = x.github_user_id
    AND j.cloudflare_account_id = x.cloudflare_account_id
    AND j.repository_id = x.repository_id
    AND j.pages_project_id = x.pages_project_id
    AND j.expected_commit_sha = x.expected_commit_sha LIMIT 1
`;

export function createD1OptionExecutionStore(env, current) {
  if (!env?.DB || !current) denied();
  const claims = new Map();
  let pending = null;

  async function checkSession() {
    return Boolean(current && await hasCurrentOwnerSession(env, current, stamp()));
  }
  async function currentExecution(id) {
    if (!UUID.test(id || '') || !await checkSession()) return null;
    const time = stamp();
    const raw = await env.DB.prepare(CURRENT_EXECUTION)
      .bind(id, current.github_user_id, current.cloudflare_account_id,
        current.authorization_epoch, time, time).first();
    if (!raw) return null;
    const reviewed = await readOwnedStoredOptionApproval(env, current, raw.option_approval_id);
    if (!reviewed || !sameSnapshot(raw, reviewed, current)) return null;
    return {raw, reviewed};
  }
  async function liveSite(jobId) {
    if (!isLaunchId(jobId) || !await checkSession()) return null;
    const j = await env.DB.prepare(
      "SELECT * FROM onboarding_launch_jobs WHERE id = ? AND github_user_id = ? " +
      "AND cloudflare_account_id = ? AND status = 'live' AND expires_at > ?"
    ).bind(jobId, current.github_user_id, current.cloudflare_account_id, stamp()).first();
    if (!j || !Number.isSafeInteger(j.repository_id) || !SHA.test(j.expected_commit_sha || ''))
      return null;
    return {
      jobId: j.id, githubUserId: j.github_user_id,
      githubLogin: j.github_login, cloudflareAccountId: j.cloudflare_account_id,
      status: j.status, repositoryId: j.repository_id,
      repositoryName: 'esp-' + j.site_slug,
      pagesProjectName: 'esp-' + j.site_slug + '-site',
      pagesProjectId: j.pages_project_id,
      productionBranch: j.production_branch, expectedCommitSha: j.expected_commit_sha
    };
  }

  const approvalStore = {
    async readApproved({id, githubUserId, cloudflareAccountId}) {
      if (githubUserId !== current.github_user_id ||
          cloudflareAccountId !== current.cloudflare_account_id) return null;
      const found = await currentExecution(id);
      if (!found) return null;
      pending = found;
      const x = found.raw;
      return {
        id: x.id, job_id: x.job_id, github_user_id: x.github_user_id,
        cloudflare_account_id: x.cloudflare_account_id, kind: x.kind,
        approval_digest: x.approval_digest, payload_json: x.payload_json,
        status: x.status
      };
    },
    async claimApproved(row) {
      if (!pending || pending.raw.id !== row.id || !await checkSession()) return false;
      const p = pending.raw;
      if (!sameSnapshot(p, pending.reviewed, current) || p.status !== 'approved')
        return false;
      const lease = crypto.randomUUID(), time = stamp();
      // Single winner. SQL conditions also fence a concurrent review rewrite,
      // repo/Pages substitution, session logout and operator grant expiry.
      const acquired = await env.DB.prepare(
        "UPDATE onboarding_option_executions AS x SET status = 'applying', " +
        "lease_id = ?, updated_at = ? WHERE x.id = ? AND x.status = 'approved' " +
        "AND x.option_approval_id = ? AND x.job_id = ? AND x.github_user_id = ? " +
        "AND x.cloudflare_account_id = ? AND x.kind = ? AND x.approval_digest = ? " +
        "AND x.payload_json = ? AND x.repository_id = ? AND x.pages_project_id = ? " +
        "AND x.expected_commit_sha = ? AND x.authorization_epoch = ? AND x.expires_at > ? " +
        "AND EXISTS (SELECT 1 FROM onboarding_sessions s WHERE s.id_hash = ? " +
        "AND s.authorization_epoch = x.authorization_epoch AND s.expires_at > ? " +
        "AND s.github_user_id = x.github_user_id AND s.cloudflare_account_id = x.cloudflare_account_id " +
        "AND s.github_token_ct IS NOT NULL AND s.cloudflare_token_ct IS NOT NULL) " +
        "AND EXISTS (SELECT 1 FROM onboarding_option_approvals o " +
        "JOIN onboarding_launch_jobs j ON j.id = o.job_id WHERE o.id = x.option_approval_id " +
        "AND o.status = 'stored' AND o.kind = x.kind AND o.approval_digest = x.approval_digest " +
        "AND o.github_user_id = x.github_user_id AND o.cloudflare_account_id = x.cloudflare_account_id " +
        "AND o.job_id = x.job_id AND j.status = 'live' AND j.expires_at > ? " +
        "AND j.repository_id = x.repository_id AND j.pages_project_id = x.pages_project_id " +
        "AND j.expected_commit_sha = x.expected_commit_sha) RETURNING id"
      ).bind(lease, time, row.id, p.option_approval_id, row.jobId,
        row.githubUserId, row.cloudflareAccountId, row.kind, row.digest,
        row.payloadJson, p.repository_id, p.pages_project_id, p.expected_commit_sha,
        p.authorization_epoch, time, current.hash, time, time).first();
      if (!acquired) return false;
      claims.set(row.id, lease);
      return true;
    },
    async finish(row, receipt) {
      const lease = claims.get(row.id);
      if (!lease || !await checkSession()) return false;
      const text = JSON.stringify(receipt);
      if (text.length > 8192) return false;
      const saved = await env.DB.prepare(
        "UPDATE onboarding_option_executions SET status = 'applied', result_json = ?, " +
        "updated_at = ? WHERE id = ? AND lease_id = ? AND status = 'applying' RETURNING id"
      ).bind(text, stamp(), row.id, lease).first();
      if (saved) claims.delete(row.id);
      return !!saved;
    },
    async fail(row, {reason}) {
      const lease = claims.get(row.id);
      if (!lease) return false;
      const saved = await env.DB.prepare(
        "UPDATE onboarding_option_executions SET status = 'needs_reconciliation', " +
        "error_code = ?, updated_at = ? WHERE id = ? AND lease_id = ? " +
        "AND status = 'applying' RETURNING id"
      ).bind(String(reason || 'provider_write_unconfirmed').slice(0,100),
        stamp(), row.id, lease).first();
      if (saved) claims.delete(row.id);
      return !!saved;
    },
    async readAppliedDomain({jobId, githubUserId, cloudflareAccountId, hostname}) {
      if (githubUserId !== current.github_user_id ||
          cloudflareAccountId !== current.cloudflare_account_id || !await checkSession()) return null;
      const r = await env.DB.prepare(
        "SELECT x.*, o.payload_json AS stored_payload_json, j.customer_name, j.github_login, " +
        "j.site_slug FROM onboarding_option_executions x " +
        "JOIN onboarding_option_approvals o ON o.id = x.option_approval_id " +
        "JOIN onboarding_launch_jobs j ON j.id = x.job_id " +
        "WHERE x.job_id = ? AND x.github_user_id = ? AND x.cloudflare_account_id = ? " +
        "AND x.kind = 'domain' AND x.status = 'applied' AND x.authorization_epoch = ? " +
        "AND o.status = 'stored' AND o.kind = 'domain' AND o.approval_digest = x.approval_digest " +
        "AND j.status = 'live' AND j.expires_at > ? AND j.repository_id = x.repository_id " +
        "AND j.pages_project_id = x.pages_project_id AND j.expected_commit_sha = x.expected_commit_sha"
      ).bind(jobId, githubUserId, cloudflareAccountId, current.authorization_epoch, stamp()).all();
      for (const x of r.results || []) {
        let payload;
        try { payload = JSON.parse(x.payload_json); } catch { continue; }
        if (payload.hostname === hostname &&
            x.option_approval_id === (await readOwnedStoredOptionApproval(env, current, x.option_approval_id))?.id)
          return {...x, payload_json: x.payload_json};
      }
      return null;
    }
  };

  async function assertCurrentAuthorization({owner, site} = {}) {
    if (owner && !owned(current, owner)) return false;
    if (!await checkSession()) return false;
    if (site) {
      const live = await liveSite(site.jobId);
      if (!live || live.repositoryId !== site.repositoryId ||
          live.pagesProjectId !== site.pagesProjectId ||
          (site.expectedCommitSha !== undefined &&
            live.expectedCommitSha !== site.expectedCommitSha) ||
          (pending && (live.expectedCommitSha !== pending.raw.expected_commit_sha ||
            live.repositoryId !== pending.raw.repository_id ||
            live.pagesProjectId !== pending.raw.pages_project_id))) return false;
    }
    for (const [id, lease] of claims) {
      // Re-evaluate the currently stored review even *after* acquiring the
      // lease. A re-reviewed/overwritten 0005 row revokes an in-flight write.
      const row = await env.DB.prepare(
        "SELECT x.id FROM onboarding_option_executions x " +
        "JOIN onboarding_option_approvals o ON o.id = x.option_approval_id " +
        "JOIN onboarding_launch_jobs j ON j.id = x.job_id " +
        "WHERE x.id = ? AND x.lease_id = ? AND x.status = 'applying' " +
        "AND x.authorization_epoch = ? AND o.status = 'stored' " +
        "AND (x.kind != 'forms' OR x.expires_at > ?) " +
        "AND o.job_id = x.job_id AND o.github_user_id = x.github_user_id " +
        "AND o.cloudflare_account_id = x.cloudflare_account_id AND o.kind = x.kind " +
        "AND o.approval_digest = x.approval_digest " +
        "AND j.status = 'live' AND j.expires_at > ? " +
        "AND j.repository_id = x.repository_id AND j.pages_project_id = x.pages_project_id " +
        "AND j.expected_commit_sha = x.expected_commit_sha"
      ).bind(id, lease, current.authorization_epoch, stamp(), stamp()).first();
      if (!row) return false;
    }
    return true;
  }

  // Receipts exist only for the claimed forms execution; recording requires the live lease.
  function provisioning() {
    if (!pending || pending.raw.kind !== 'forms' || !claims.has(pending.raw.id)) return null;
    return createD1FormsProvisioningStore(env, current,
      {optionApprovalId: pending.raw.option_approval_id, jobId: pending.raw.job_id});
  }
  const formsReceipts = Object.freeze({
    async read() { return await provisioning()?.read() ?? null; },
    async record(fields) {
      if (!await assertCurrentAuthorization()) return null;
      return await provisioning()?.record(fields) ?? null;
    }
  });

  async function assertOperatorApprovedExecution({provider, method, path, requestBody}) {
    if (provider !== 'cloudflare' || method !== 'POST' ||
        !pending || !claims.has(pending.raw.id) ||
        !await assertCurrentAuthorization()) return false;
    const x = pending.raw, p = pending.reviewed.normalizedPayload;
    if (x.kind === 'forms') {
      const site = pending.reviewed.currentSite;
      let gate = null;
      try {
        gate = await createFormsCostPrivacyGate(env, current)({jobId: x.job_id,
          owner: {githubUserId: current.github_user_id, githubLogin: current.github_login,
            cloudflareAccountId: current.cloudflare_account_id},
          site, formsDigest: x.approval_digest});
      } catch { return false; }
      // Read the receipt fresh: each write is bound to its own step and the recorded D1.
      const receipt = await provisioning()?.read();
      return isApprovedFormsMutation({method, path, requestBody, gate, receipt,
        accountId: x.cloudflare_account_id, pagesProjectName: site.pagesProjectName, hostname: p.hostname}) &&
        await assertCurrentAuthorization();
    }
    if (x.kind === 'domain') {
      return path === '/accounts/' + x.cloudflare_account_id +
        '/pages/projects/' + pending.reviewed.currentSite.pagesProjectName + '/domains' &&
        Object.keys(requestBody || {}).join(',') === 'name' &&
        requestBody.name === p.hostname;
    }
    if (x.kind === 'email') {
      const rule = requestBody;
      return /^\/zones\/[a-f0-9]{32}\/email\/routing\/rules$/.test(path) &&
        rule?.name === 'Launch & Own contact forwarding for ' + p.hostname &&
        rule?.enabled === true && rule?.source === 'api' &&
        Array.isArray(rule.matchers) && rule.matchers.length === 1 &&
        rule.matchers[0]?.type === 'literal' && rule.matchers[0]?.field === 'to' &&
        rule.matchers[0]?.value === 'contact@' + p.hostname &&
        Array.isArray(rule.actions) && rule.actions.length === 1 &&
        rule.actions[0]?.type === 'forward' &&
        Array.isArray(rule.actions[0]?.value) && rule.actions[0].value.length === 1 &&
        rule.actions[0].value[0] === p.mailbox &&
        Object.keys(rule).sort().join(',') === 'actions,enabled,matchers,name,source';
    }
    return false;
  }
  return Object.freeze({
    approvalStore,
    siteStore: {readLiveSite: ({jobId}) => liveSite(jobId)},
    assertCurrentAuthorization, assertOperatorApprovedExecution, formsReceipts
  });
}
