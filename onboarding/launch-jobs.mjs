import { planCustomer } from '../pipeline/plan-customer.mjs';
import { renderSite } from '../site/render-site.mjs';
import { sha256 } from './crypto.mjs';
import { RECEIPT_TTL_SECONDS } from './launch-receipts.mjs';
import { isZipArtifact } from './zip-artifacts.mjs';

export const UNCLAIMED = '(j.lease_until IS NULL OR j.lease_until <= ?)';
export const RUNNABLE = "j.status IN ('queued', 'pending_deployment')";
// Only the matching, currently selected account on the approving session grants authority.
const APPROVAL_TABLES = 'onboarding_launch_job_sessions a JOIN onboarding_sessions s ON s.id_hash = a.session_hash';
const CURRENT_APPROVAL = `a.job_id = j.id AND a.authorization_epoch = s.authorization_epoch
    AND s.github_user_id = j.github_user_id AND lower(s.github_login) = lower(j.github_login)
    AND s.cloudflare_account_id = j.cloudflare_account_id AND s.cloudflare_token_ct IS NOT NULL
    AND s.expires_at > ?`;
export const HAS_APPROVAL = `EXISTS (SELECT 1 FROM ${APPROVAL_TABLES} WHERE ${CURRENT_APPROVAL})`;
const OWNED = 'j.github_user_id = ? AND j.cloudflare_account_id = ? AND j.expires_at > ?';
const idPattern = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
export const isLaunchId = id => typeof id === 'string' && idPattern.test(id);
const ownerBindings = (session, time) => [session.github_user_id, session.cloudflare_account_id, time];

function jobInput(job) {
  const plan = JSON.parse(job.plan_json);
  const input = { name: job.customer_name, githubOwner: job.github_login,
    accountId: job.cloudflare_account_id, forms: false };
  const planned = planCustomer(input);
  if (plan.customer !== planned.customer || plan.accountId !== planned.accountId ||
      plan.githubOwner !== planned.githubOwner || plan.domain !== planned.domain || plan.forms !== false) {
    throw Error('Stored plan does not describe the approved target');
  }
  return { input, plan };
}

export async function approvalSnapshot(item, githubUserId) {
  const { input, plan } = jobInput(item);
  const id = item.job_id ?? item.id;
  if (!isLaunchId(id) || !Number.isSafeInteger(githubUserId) || githubUserId < 1) {
    throw Error('Invalid launch approval snapshot');
  }
  const target = [id, item.legacy_receipt_id ?? null, githubUserId,
    item.github_login, item.cloudflare_account_id, item.customer_name, item.plan_json];
  if (Object.hasOwn(plan, 'zip')) {
    if (!isZipArtifact(plan.zip) || plan.zip.id !== id || item.legacy_receipt_id != null || item.approved_html) {
      throw Error('Invalid ZIP approval snapshot');
    }
    const digest = await sha256(JSON.stringify([2, ...target]));
    return { id, slug: plan.customer, html: '', zip: plan.zip, digest, input };
  }
  const html = item.approved_html ?? renderSite({ ...plan.site, name: item.customer_name });
  if (typeof html !== 'string' || !html.length || Buffer.byteLength(html) > 32768) {
    throw Error('Invalid launch approval snapshot');
  }
  const digest = await sha256(JSON.stringify([1, ...target, html]));
  return { id, slug: plan.customer, html, digest, input };
}

const HAS_REVIEW = `EXISTS (
  SELECT 1 FROM onboarding_launches p JOIN onboarding_sessions s ON s.id_hash = p.session_hash
  WHERE p.id = ? AND p.session_hash = ? AND p.status = 'preview' AND p.plan_json = ?
    AND p.job_id IS ? AND p.legacy_receipt_id IS ? AND p.preview_html IS ? AND p.customer_name = ?
    AND p.github_login = ? AND p.cloudflare_account_id = ?
    AND s.github_user_id = ? AND lower(s.github_login) = lower(p.github_login)
    AND s.cloudflare_account_id = p.cloudflare_account_id AND s.cloudflare_token_ct IS NOT NULL
    AND s.authorization_epoch = ? AND s.expires_at > ?
)`;

export async function approveJob(env, { preview, session, snapshot, receipt, time }) {
  const review = [preview.id, session.hash, preview.plan_json, preview.job_id, preview.legacy_receipt_id,
    preview.preview_html, preview.customer_name, preview.github_login, preview.cloudflare_account_id, session.github_user_id,
    session.authorization_epoch, time];
  let approval;
  if (preview.job_id) {
    approval = env.DB.prepare(`UPDATE onboarding_launch_jobs AS j
      SET status = CASE WHEN provisioned_at IS NULL THEN 'queued' ELSE 'pending_deployment' END,
        attempts = 0, next_attempt_at = ?, updated_at = ?, error_code = NULL, lease_id = NULL, lease_until = NULL
      WHERE id = ? AND ${OWNED} AND approval_digest = ? AND ${UNCLAIMED}
        AND (status IN ('needs_reauthorization', 'failed') OR (status != 'live' AND NOT ${HAS_APPROVAL}))
        AND ${HAS_REVIEW}`)
      .bind(time, time, snapshot.id, ...ownerBindings(session, time), snapshot.digest, time, time, ...review);
  } else {
    approval = env.DB.prepare(`INSERT INTO onboarding_launch_jobs
      (id, github_user_id, github_login, cloudflare_account_id, customer_name, site_slug, plan_json,
        approved_html, approval_digest, legacy_receipt_id, status, approved_at, updated_at, expires_at, next_attempt_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?
      WHERE ${HAS_REVIEW} AND (? IS NULL OR EXISTS (SELECT 1 FROM onboarding_launch_receipts r
        WHERE r.id = ? AND r.github_user_id = ? AND r.cloudflare_account_id = ? AND r.expires_at > ?
          AND r.status != 'live'))
      ON CONFLICT DO NOTHING`)
      .bind(snapshot.id, session.github_user_id, preview.github_login, preview.cloudflare_account_id,
        preview.customer_name, snapshot.slug, preview.plan_json, snapshot.html, snapshot.digest,
        preview.legacy_receipt_id, receipt?.approved_at ?? time, time, receipt?.expires_at ?? time + RECEIPT_TTL_SECONDS, time,
        ...review, preview.legacy_receipt_id, preview.legacy_receipt_id, ...ownerBindings(session, time));
  }
  // D1 executes the batch on one connection in a transaction. Each statement
  // depends on the preceding write so a losing approval cannot bind a session.
  const [created] = await env.DB.batch([
    approval,
    env.DB.prepare(`INSERT INTO onboarding_launch_job_sessions(job_id, session_hash, authorization_epoch)
      SELECT ?, ?, ? WHERE changes() = 1
      ON CONFLICT(job_id) DO UPDATE SET session_hash = excluded.session_hash, authorization_epoch = excluded.authorization_epoch`)
      .bind(snapshot.id, session.hash, session.authorization_epoch),
    env.DB.prepare(`UPDATE onboarding_launches
      SET job_id = ?, preview_html = NULL, status = 'approved', approved_at = ?, updated_at = ?
      WHERE changes() = 1 AND id = ? AND session_hash = ? AND status = 'preview'`)
      .bind(snapshot.id, time, time, preview.id, session.hash)
  ]);
  return created.meta.changes === 1;
}

const resumable = `j.status != 'live' AND ${UNCLAIMED}
  AND (j.status IN ('needs_reauthorization', 'failed') OR NOT ${HAS_APPROVAL})`;
const statusColumn = `CASE WHEN ${RUNNABLE} AND NOT ${HAS_APPROVAL}
  THEN 'needs_reauthorization' ELSE j.status END AS display_status`;
const deletable = `(${UNCLAIMED} AND (NOT (${RUNNABLE}) OR NOT ${HAS_APPROVAL}))`;

export async function listOwnedJobs(env, session, time) {
  const result = await env.DB.prepare(`SELECT j.id, j.customer_name, j.site_slug, j.updated_at,
      j.expires_at, j.expected_commit_sha, j.approval_digest, j.error_code, ${statusColumn},
      CASE WHEN j.status='live' AND j.production_branch='main'
          AND j.repository_id IS NOT NULL AND j.repository_id > 0
          AND json_type(j.plan_json,'$.site')='object'
          AND COALESCE(json_extract(j.plan_json,'$.site.layout'),'')!='multi-page'
          AND json_extract(j.plan_json,'$.forms')=0
          AND json_type(j.plan_json,'$.zip') IS NULL THEN 1 ELSE 0 END AS can_edit,
      CASE WHEN json_type(j.plan_json,'$.zip') IS NOT NULL THEN 1 ELSE 0 END AS uploaded_zip,
      (${resumable}) AS can_restore, ${deletable} AS can_delete
    FROM onboarding_launch_jobs j WHERE ${OWNED} ORDER BY j.updated_at DESC LIMIT 20`)
    .bind(time, time, time, time, time, ...ownerBindings(session, time)).all();
  return result.results;
}

export async function hasCurrentOwnerSession(env, session, time) {
  const active = await env.DB.prepare(`SELECT 1 FROM onboarding_sessions
    WHERE id_hash = ? AND authorization_epoch = ? AND github_user_id = ?
      AND cloudflare_account_id = ? AND github_token_ct IS NOT NULL
      AND cloudflare_token_ct IS NOT NULL AND expires_at > ?`)
    .bind(session.hash, session.authorization_epoch, ...ownerBindings(session, time)).first();
  return Boolean(active);
}

export async function getOwnedJob(env, session, id, time) {
  if (!isLaunchId(id)) return null;
  return await env.DB.prepare(`SELECT j.*, ${statusColumn}, (${resumable}) AS can_restore
    FROM onboarding_launch_jobs j WHERE j.id = ? AND ${OWNED}`)
    .bind(time, time, time, id, ...ownerBindings(session, time)).first();
}

export async function deleteOwnedLaunch(env, session, id, time) {
  if (!isLaunchId(id)) return false;
  const guard = `EXISTS (SELECT 1 FROM onboarding_sessions s WHERE s.id_hash = ?
    AND s.authorization_epoch = ? AND s.expires_at > ?)`;
  // If legacy history was the source of this job, delete it in the same transaction.
  const results = await env.DB.batch([
    env.DB.prepare(`DELETE FROM onboarding_launch_receipts WHERE ${guard}
      AND (id = (SELECT j.legacy_receipt_id FROM onboarding_launch_jobs j
        WHERE j.id = ? AND ${OWNED} AND ${deletable})
        OR (id = ? AND NOT EXISTS (SELECT 1 FROM onboarding_launch_jobs WHERE legacy_receipt_id = ?)))
      AND github_user_id = ? AND cloudflare_account_id = ? AND expires_at > ?`)
      .bind(session.hash, session.authorization_epoch, time, id, ...ownerBindings(session, time),
        time, time, id, id, ...ownerBindings(session, time)),
    env.DB.prepare(`DELETE FROM onboarding_launch_jobs AS j
      WHERE ${guard} AND j.id = ? AND ${OWNED} AND ${deletable}`)
      .bind(session.hash, session.authorization_epoch, time, id, ...ownerBindings(session, time), time, time)
  ]);
  return results.some(result => result.meta.changes > 0);
}

export async function activeJobSession(env, job, deadline, { credentialsValid = false, loadGrants = false } = {}) {
  const grantExpiry = credentialsValid ? `, COALESCE(s.github_token_expires_at, s.expires_at),
    COALESCE(s.cloudflare_token_expires_at, s.expires_at)` : '';
  const fields = loadGrants ? 's.*, s.id_hash AS hash'
    : `MIN(s.expires_at, j.lease_until, j.expires_at${grantExpiry}) AS authorized_until`;
  return await env.DB.prepare(`SELECT ${fields} FROM onboarding_launch_jobs j, ${APPROVAL_TABLES}
    WHERE ${CURRENT_APPROVAL}
    AND j.id = ? AND j.lease_id = ? AND j.lease_until > ? AND j.expires_at > ? AND ${RUNNABLE}
    AND (? = 0 OR ((s.github_token_expires_at IS NULL OR s.github_token_expires_at > ?)
      AND (s.cloudflare_token_expires_at IS NULL OR s.cloudflare_token_expires_at > ?)))`)
    .bind(deadline, job.id, job.lease_id, deadline, deadline, credentialsValid ? 1 : 0, deadline, deadline).first();
}
