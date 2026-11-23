/**
 * Agent draft → normal onboarding review (#43 item 5).
 *
 * The owner opens /review?draft=<id> from their AI client. Onboarding asks the
 * bridge for that draft with a sealed ticket carrying the *session's* GitHub
 * user and Cloudflare account, re-renders it, requires the exact digest the
 * agent was given, and stores an ordinary preview launch. Approval, launch and
 * verification then run through the existing onboarding job runner unchanged.
 */
import {BRIDGE_STATUS_VERSION, DRAFT_ID, mintOwnerTicket, openOwnerTicket} from '../integration/draft-handoff.mjs';
import {planCustomer} from '../pipeline/plan-customer.mjs';
import {normalizeSite, renderSite} from '../site/render-site.mjs';
import {sha256} from './crypto.mjs';
import {HAS_APPROVAL, RUNNABLE} from './launch-jobs.mjs';
import {readBounded} from './website-zip.mjs';

const configured = env => /^[a-f0-9]{64}$/i.test(String(env.BRIDGE_TICKET_KEY)) &&
  /^https:\/\/[a-z0-9.-]+$/i.test(String(env.BRIDGE_ORIGIN));
const SHA = /^[a-f0-9]{40}$/i;
const MAX_STATUS_REQUEST_BYTES = 4096;
const activeSession = `s.id_hash = ? AND s.authorization_epoch = ? AND s.github_user_id = ?
  AND s.cloudflare_account_id = ? AND s.github_login = ? AND s.expires_at > ?
  AND s.github_token_ct IS NOT NULL AND s.cloudflare_token_ct IS NOT NULL`;
const matchingDraft = `p.session_hash = s.id_hash AND p.cloudflare_account_id = s.cloudflare_account_id
  AND p.github_login = s.github_login AND json_extract(p.plan_json, '$.bridgeDraftId') = ?`;

const sessionBindings = (current, time) => [current.hash, current.authorization_epoch,
  current.github_user_id, current.cloudflare_account_id, current.github_login, time];

function readCurrentDraft(env, current, draftId, time) {
  return env.DB.prepare(`SELECT (SELECT p.id FROM onboarding_launches p WHERE ${matchingDraft}
    ORDER BY p.job_id IS NULL, p.created_at, p.id LIMIT 1) AS id
    FROM onboarding_sessions s WHERE ${activeSession}`)
    .bind(draftId, ...sessionBindings(current, time)).first();
}

export async function importBridgeDraft(env, current, draftId, {redirect, fail, now, fetchFn = fetch}) {
  if (!current?.cloudflare_account_id || !current.cloudflare_token_ct || !current.hash ||
      !current.github_login || !Number.isSafeInteger(current.authorization_epoch) ||
      !Number.isSafeInteger(current.github_user_id) || current.github_user_id < 1)
    return fail('Sign in with GitHub and choose your Cloudflare account, then open the review link from your AI chat again.', 403);
  if (!DRAFT_ID.test(String(draftId))) return fail('This review link is not valid.', 400);
  if (!configured(env)) return fail('Agent drafts are not available on this host yet.', 503);

  const changed = () => fail('Your account connection changed. Reconnect before opening this draft.', 403);
  const existing = await readCurrentDraft(env, current, draftId, now());
  if (!existing) return changed();
  if (existing.id) return redirect('/review?id=' + encodeURIComponent(existing.id));

  const ticket = await mintOwnerTicket(env.BRIDGE_TICKET_KEY, 'draft', {draftId,
    githubUserId: current.github_user_id, cloudflareAccountId: current.cloudflare_account_id,
    nowSeconds: now()});
  let draft;
  try {
    const res = await fetchFn(env.BRIDGE_ORIGIN + '/mcp/internal/draft', {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(8000),
      headers: {'content-type': 'application/json', 'user-agent': 'launch-and-own-onboarding'},
      body: JSON.stringify({ticket})
    });
    draft = res.ok ? await res.json() : null;
  } catch {
    return fail('Could not reach the agent bridge. Try again in a moment.', 502);
  }
  if (!draft?.site_spec || draft.draft_id !== draftId)
    return fail('This draft has expired or belongs to a different account. Ask your AI chat to prepare it again.', 404);

  const spec = draft.site_spec;
  const site = normalizeSite({name: spec.name, tagline: spec.headline, about: spec.about,
    services: spec.services, theme: spec.theme || 'ocean', contactEmail: spec.contactEmail || ''});
  const html = renderSite(site);
  // The owner must approve exactly the page the agent described by digest.
  if (await sha256(html) !== draft.preview_sha256)
    return fail('This draft no longer matches its preview. Ask your AI chat to prepare it again.', 409);

  const plan = planCustomer({name: site.name, accountId: current.cloudflare_account_id,
    githubOwner: current.github_login, forms: false});
  const id = crypto.randomUUID(), ts = now();
  if (!Number.isSafeInteger(draft.expires_at) || draft.expires_at <= ts)
    return fail('This draft has expired. Ask your AI chat to prepare it again.', 404);

  // D1 serializes the conditional insert. A competing request reuses the
  // same preview and an invalidated session cannot create one.
  await env.DB.prepare(`INSERT INTO onboarding_launches
    (id,session_hash,customer_name,cloudflare_account_id,github_login,plan_json,status,created_at,updated_at,preview_html)
    SELECT ?, s.id_hash, ?, s.cloudflare_account_id, s.github_login, ?, 'preview', ?, ?, ?
    FROM onboarding_sessions s WHERE ${activeSession}
      AND NOT EXISTS (SELECT 1 FROM onboarding_launches p WHERE ${matchingDraft})`)
    .bind(id, site.name, JSON.stringify({...plan, site, bridgeDraftId: draftId}), ts, ts, html,
      ...sessionBindings(current, ts), draftId).run();
  const staged = await readCurrentDraft(env, current, draftId, now());
  return staged?.id ? redirect('/review?id=' + encodeURIComponent(staged.id)) : changed();
}

function readDraftJob(env, owner, time) {
  return env.DB.prepare(`SELECT j.id, j.updated_at, j.expected_commit_sha, j.approved_html,
    CASE WHEN NOT EXISTS (SELECT 1 FROM onboarding_sessions s
      WHERE s.github_user_id = j.github_user_id AND s.cloudflare_account_id = j.cloudflare_account_id
        AND s.expires_at > ? AND s.github_token_ct IS NOT NULL AND s.cloudflare_token_ct IS NOT NULL)
      OR (${RUNNABLE} AND NOT ${HAS_APPROVAL})
      THEN 'needs_reauthorization' ELSE j.status END AS status
    FROM onboarding_launch_jobs j WHERE j.github_user_id = ? AND j.cloudflare_account_id = ?
      AND j.expires_at > ? AND json_extract(j.plan_json, '$.bridgeDraftId') = ?
    ORDER BY j.approved_at DESC, j.id LIMIT 1`)
    .bind(time, time, owner.githubUserId, owner.cloudflareAccountId, time, owner.draftId).first();
}

/** Bridge → onboarding: launch state for an agent draft, fenced by owner. */
export async function bridgeLaunchStatus(request, env, {now}) {
  const json = (body, status = 200) => Response.json(body, {status, headers: {'cache-control': 'no-store'}});
  const report = body => json({handoff_version: BRIDGE_STATUS_VERSION, ...body});
  if (!configured(env) || new URL(request.url).origin !== env.ONBOARDING_ORIGIN)
    return json({error: 'not_found'}, 404);
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || ''))
    return json({error: 'invalid_handoff'}, 400);
  const oversized = () => json({error: 'handoff_too_large'}, 413);
  if (Number(request.headers.get('content-length')) > MAX_STATUS_REQUEST_BYTES) return oversized();
  let owner;
  try {
    const bytes = await readBounded(request.body, MAX_STATUS_REQUEST_BYTES);
    if (!bytes) return oversized();
    const body = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
    owner = await openOwnerTicket(env.BRIDGE_TICKET_KEY, 'status', body?.ticket, {nowSeconds: now()});
  } catch {
    return json({error: 'invalid_handoff'}, 400);
  }
  const job = await readDraftJob(env, owner, now());
  if (!job || job.status !== 'live') return report({status: job?.status ?? 'draft'});
  if (!SHA.test(job.expected_commit_sha || '') || !job.approved_html ||
      !Number.isSafeInteger(job.updated_at) || job.updated_at <= 0 || job.updated_at > now())
    return report({status: 'pending_deployment'});

  const verifiedHtmlSha = await sha256(job.approved_html);
  const latest = await readDraftJob(env, owner, now());
  if (!latest || latest.status !== 'live') return report({status: latest?.status ?? 'draft'});
  if (latest.id !== job.id || latest.updated_at !== job.updated_at ||
      latest.expected_commit_sha !== job.expected_commit_sha || latest.approved_html !== job.approved_html)
    return report({status: 'pending_deployment'});

  return report({status: 'last_verified', last_verified_at: job.updated_at,
    last_verified_commit_sha: job.expected_commit_sha, last_verified_html_sha256: verifiedHtmlSha});
}
