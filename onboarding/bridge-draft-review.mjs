/**
 * Agent draft → normal onboarding review (#43 item 5).
 *
 * The owner opens /review?draft=<id> from their AI client. Onboarding asks the
 * bridge for that draft with a sealed ticket carrying the *session's* GitHub
 * user and Cloudflare account, re-renders it, requires the exact digest the
 * agent was given, and stores an ordinary preview launch. Approval, launch and
 * verification then run through the existing onboarding job runner unchanged.
 */
import {DRAFT_ID, mintOwnerTicket, openOwnerTicket} from '../integration/draft-handoff.mjs';
import {planCustomer} from '../pipeline/plan-customer.mjs';
import {normalizeSite, renderSite} from '../site/render-site.mjs';
import {sha256} from './crypto.mjs';

const configured = env => /^[a-f0-9]{64}$/i.test(String(env.BRIDGE_TICKET_KEY)) &&
  /^https:\/\/[a-z0-9.-]+$/i.test(String(env.BRIDGE_ORIGIN));

export async function importBridgeDraft(env, current, draftId, {redirect, fail, now, fetchFn = fetch}) {
  if (!current?.cloudflare_account_id || !current.cloudflare_token_ct ||
      !Number.isSafeInteger(current.github_user_id) || current.github_user_id < 1)
    return fail('Sign in with GitHub and choose your Cloudflare account, then open the review link from your AI chat again.', 403);
  if (!DRAFT_ID.test(String(draftId))) return fail('This review link is not valid.', 400);
  if (!configured(env)) return fail('Agent drafts are not available on this host yet.', 503);

  const existing = await env.DB.prepare(`SELECT id FROM onboarding_launches
    WHERE session_hash=? AND json_extract(plan_json,'$.bridgeDraftId')=? LIMIT 1`)
    .bind(current.hash, draftId).first();
  if (existing) return redirect('/review?id=' + encodeURIComponent(existing.id));

  const ticket = await mintOwnerTicket(env.BRIDGE_TICKET_KEY, 'draft', {draftId,
    githubUserId: current.github_user_id, cloudflareAccountId: current.cloudflare_account_id,
    nowSeconds: now()});
  let draft;
  try {
    const res = await fetchFn(env.BRIDGE_ORIGIN + '/mcp/internal/draft', {
      method: 'POST', redirect: 'manual',
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
  await env.DB.prepare(`INSERT INTO onboarding_launches
    (id,session_hash,customer_name,cloudflare_account_id,github_login,plan_json,status,created_at,updated_at,preview_html)
    VALUES(?,?,?,?,?,?,'preview',?,?,?)`)
    .bind(id, current.hash, site.name, current.cloudflare_account_id, current.github_login,
      JSON.stringify({...plan, site, bridgeDraftId: draftId}), ts, ts, html).run();
  return redirect('/review?id=' + encodeURIComponent(id));
}

/** Bridge → onboarding: launch state for an agent draft, fenced by owner. */
export async function bridgeLaunchStatus(request, env, {now}) {
  const json = (body, status = 200) => Response.json(body, {status, headers: {'cache-control': 'no-store'}});
  if (!configured(env)) return json({error: 'not_found'}, 404);
  let owner;
  try {
    const body = await request.json();
    owner = await openOwnerTicket(env.BRIDGE_TICKET_KEY, 'status', body?.ticket, {nowSeconds: now()});
  } catch {
    return json({error: 'invalid_handoff'}, 400);
  }
  const job = await env.DB.prepare(`SELECT status, expected_commit_sha, approved_html
    FROM onboarding_launch_jobs WHERE github_user_id=? AND cloudflare_account_id=?
      AND json_extract(plan_json,'$.bridgeDraftId')=? LIMIT 1`)
    .bind(owner.githubUserId, owner.cloudflareAccountId, owner.draftId).first();
  if (!job) return json({status: 'draft'});
  if (job.status !== 'live') return json({status: job.status});
  return json({status: 'live', production_commit_sha: job.expected_commit_sha,
    approved_html_sha256: await sha256(job.approved_html)});
}
