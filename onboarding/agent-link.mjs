/**
 * Browser agent-link: mint a sealed bridge ticket from the onboarding session
 * and complete the link against the MCP bridge Worker (server-side).
 *
 * Does not accept provider IDs from the form — only challenge_id + CSRF.
 * Requires secrets BRIDGE_TICKET_KEY and var BRIDGE_ORIGIN when linking is live.
 */
import {mintBrowserLinkTicket} from '../integration/browser-link-ticket.mjs';
import {BridgeContractError} from '../integration/tool-contract.mjs';

const CHALLENGE = /^link_[a-f0-9]{20,64}$/i;

function exactHttpsOrigin(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password &&
      !url.search && !url.hash && url.pathname === '/' && url.origin === value;
  } catch {
    return false;
  }
}

function bridgeConfigured(env) {
  return typeof env.BRIDGE_TICKET_KEY === 'string' &&
    /^[a-f0-9]{64}$/i.test(env.BRIDGE_TICKET_KEY) &&
    exactHttpsOrigin(env.BRIDGE_ORIGIN);
}

function linkedSession(current) {
  return current?.cloudflare_account_id && current.cloudflare_token_ct &&
    Number.isSafeInteger(current.github_user_id) && current.github_user_id > 0;
}

/**
 * @param {object} ui helpers from worker.mjs: {view, fail, button, escape}
 */
export async function showAgentLink(env, current, challengeId, ui) {
  const {view, fail, button, escape} = ui;
  if (!current)
    return view('Connect your accounts',
      '<p>Sign in with GitHub to link this chat session to Launch &amp; Own.</p>' +
      '<p><a href="/connect/github">Connect GitHub</a></p>');
  if (!linkedSession(current))
    return view('Finish connecting providers',
      `<p class="pill">GitHub: ${escape(current.github_login)}</p>` +
      '<p>Connect Cloudflare and select an account before linking an agent.</p>' +
      (current.cloudflare_token_ct
        ? '<p><a href="/">Choose Cloudflare account</a></p>'
        : '<p><a href="/connect/cloudflare">Connect Cloudflare</a></p>'));
  if (typeof challengeId !== 'string' || !CHALLENGE.test(challengeId))
    return fail('This agent link request is missing a valid challenge.', 400);
  if (!bridgeConfigured(env))
    return view('Agent linking not ready',
      '<p>Account linking for chat agents is not configured on this onboarding host yet.</p>' +
      '<p><a href="/">Return to setup</a></p>');

  return view('Link this chat session',
    `<p>Confirm that <strong>${escape(current.github_login)}</strong> and your selected Cloudflare account should authorize the waiting chat agent.</p>` +
    '<p class="muted">No API tokens are shown or pasted. The agent never supplies GitHub or Cloudflare identities.</p>' +
    button('/agent-link', 'Confirm and link agent', current.csrf,
      `<input type="hidden" name="challenge_id" value="${escape(challengeId)}">`));
}

export async function confirmAgentLink(request, env, current, ui, {
  assertCsrf, formData, now, fetchImpl = globalThis.fetch
}) {
  const {view, fail, escape} = ui;
  if (!current) return fail('Please connect GitHub again', 400);
  if (!linkedSession(current))
    return fail('Connect Cloudflare and select an account first.', 400);
  if (!bridgeConfigured(env))
    return fail('Agent linking is not configured.', 503);

  const form = await formData(request);
  assertCsrf(request, form, current, env.ONBOARDING_ORIGIN);
  const challengeId = form.get('challenge_id');
  if (typeof challengeId !== 'string' || !CHALLENGE.test(challengeId) ||
      form.getAll('challenge_id').length !== 1)
    return fail('This agent link request is missing a valid challenge.', 400);

  let ticket;
  try {
    ticket = await mintBrowserLinkTicket(env.BRIDGE_TICKET_KEY, {
      challengeId,
      githubUserId: current.github_user_id,
      cloudflareAccountId: current.cloudflare_account_id,
      nowSeconds: now(),
      ttlSeconds: 300
    });
  } catch (error) {
    if (error instanceof BridgeContractError)
      return fail('This agent link request could not be sealed.', 400);
    throw error;
  }

  let bridgeResponse;
  try {
    bridgeResponse = await fetchImpl(`${env.BRIDGE_ORIGIN}/mcp/link/browser`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store'
      },
      body: JSON.stringify({ticket})
    });
  } catch {
    return fail('Could not reach the agent bridge. Try again in a moment.', 502);
  }

  let body = null;
  try { body = await bridgeResponse.json(); } catch { body = null; }
  if (!bridgeResponse.ok || !body?.linked)
    return fail('The agent bridge rejected this link. Ask the chat to start connecting again.', 400);

  return view('Agent linked',
    `<p role="status">Your GitHub and Cloudflare accounts are linked for this chat session.</p>` +
    `<p class="muted">GitHub user ${escape(String(body.github_user_id))} · Cloudflare account selected · epoch ${escape(String(body.authorization_epoch))}</p>` +
    '<p>Return to ChatGPT or Claude and continue. You can close this tab.</p>' +
    '<p><a href="/">Back to website setup</a></p>');
}
