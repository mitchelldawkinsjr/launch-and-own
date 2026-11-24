/**
 * Isolated authenticated transport for the shared agent bridge.
 *
 * Accepts opaque agent access tokens issued by a trusted host (tests use
 * MemoryAgentTokenStore). Reconstructs principal server-side — never from
 * model tool arguments. Dispatches allowlisted tools through tool-contract.
 *
 * NOT a deployed MCP server, OAuth AS, or Worker route. No provider I/O.
 */
import {DRAFT_ID, draftForOnboarding, draftPublicationRecord} from './draft-handoff.mjs';
import {
  BRIDGE_AUDIENCE, BROWSER_ORIGIN, BridgeContractError,
  assertSafeBrowserHandoff, assertTrustedPrincipal, publicationStatus, validateToolCall
} from './tool-contract.mjs';
import {
  MemoryOwnerLinkStore, linkedOwnerFromStore
} from './owner-link-store.mjs';
import {
  RESOURCE_METADATA_PATH, RESOURCE_URI, protectedResourceMetadata
} from './protected-resource.mjs';
import {MemorySiteDraftStore} from './site-draft-store.mjs';
import {MemoryJobPublicationStore} from './job-publication-store.mjs';
import {openBrowserLinkTicket} from './browser-link-ticket.mjs';
import {randomBytes} from 'node:crypto';

const deny = code => { throw new BridgeContractError(code); };

export class MemoryAgentTokenStore {
  #tokens = new Map();

  /** Issue an opaque bearer for (subject, clientId). Not a JWT. */
  issue({subject, clientId, nowSeconds, ttlSeconds = 3600, audience = BRIDGE_AUDIENCE}) {
    if (typeof subject !== 'string' || typeof clientId !== 'string' ||
        !Number.isSafeInteger(nowSeconds) || audience !== BRIDGE_AUDIENCE)
      deny('unauthenticated');
    const token = 'agt_' + randomBytes(24).toString('hex');
    this.#tokens.set(token, Object.freeze({
      subject, clientId, audience, expiresAt: nowSeconds + ttlSeconds
    }));
    return token;
  }

  lookup(token, {nowSeconds, expectedAudience = BRIDGE_AUDIENCE}) {
    if (typeof token !== 'string' || !token.startsWith('agt_')) return null;
    const row = this.#tokens.get(token);
    if (!row || row.audience !== expectedAudience ||
        !Number.isSafeInteger(nowSeconds) || row.expiresAt <= nowSeconds)
      return null;
    return row;
  }

  revoke(token) {
    this.#tokens.delete(token);
  }
}

export function createBridgeHost({
  tokens = new MemoryAgentTokenStore(),
  links = new MemoryOwnerLinkStore(),
  sites = new MemorySiteDraftStore(),
  jobs = new MemoryJobPublicationStore(),
  nowSeconds = () => Math.floor(Date.now() / 1000),
  resourceUri = RESOURCE_URI,
  // Trusted provider facts for update fences — supplied by host, never by model.
  currentCommitSha = null,
  currentRepositoryId = null,
  // 64-hex key shared with onboarding for sealed browser link tickets.
  bridgeTicketKey = null,
  // async (sealedStatusTicket) => onboarding launch report for a bridge draft.
  onboardingStatus = null
} = {}) {
  return {
    tokens, links, sites, jobs, nowSeconds, resourceUri,
    currentCommitSha, currentRepositoryId, bridgeTicketKey, onboardingStatus
  };
}

function bearerFromAuthorization(header) {
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

async function principalFromToken(host, token) {
  const now = host.nowSeconds();
  const session = await Promise.resolve(host.tokens.lookup(token, {nowSeconds: now}));
  if (!session) deny('unauthenticated');
  const linkedOwner = await linkedOwnerFromStore(host.links, session.subject, session.clientId);
  return {
    authenticated: true,
    audience: BRIDGE_AUDIENCE,
    subject: session.subject,
    clientId: session.clientId,
    expiresAt: session.expiresAt ?? (now + 60),
    linkedOwner
  };
}

function jsonError(code, status = 401) {
  return {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'www-authenticate': 'Bearer realm="launch-and-own-mcp", resource="' + RESOURCE_URI + '"'
    },
    body: {error: code}
  };
}

function jsonOk(body, status = 200) {
  return {
    status,
    headers: {'content-type': 'application/json', 'cache-control': 'no-store'},
    body
  };
}

/**
 * Minimal HTTP-shaped dispatcher used by tests (and later a Worker adapter).
 * Supported routes:
 *   GET  /.well-known/oauth-protected-resource
 *   POST /mcp/tools/call   { name, arguments }  + Authorization: Bearer …
 *   POST /mcp/link/browser { ticket } — sealed onboarding ticket only
 *     (optional agent Bearer; ticket-only uses challenge subject/client)
 *
 * Agent-supplied `verified` provider maps are never accepted.
 */
export async function handleBridgeRequest(host, request) {
  const method = String(request.method || 'GET').toUpperCase();
  // Resolve against the browser origin, not RESOURCE_URI (/mcp), so paths like
  // /mcp/tools/call do not double the resource suffix.
  const url = new URL(request.url, BROWSER_ORIGIN);
  const path = url.pathname;

  if (method === 'GET' && path === RESOURCE_METADATA_PATH)
    return jsonOk(protectedResourceMetadata({resource: host.resourceUri}));

  try {
    if (method === 'POST' && path === '/mcp/tools/call')
      return await dispatchToolCall(host, request);
    if (method === 'POST' && path === '/mcp/link/browser')
      return await completeBrowserLink(host, request);
    if (method === 'POST' && path === '/mcp/internal/draft')
      return jsonOk(await draftForOnboarding(host, readJsonBody(request).ticket));
  } catch (error) {
    if (error instanceof BridgeContractError) {
      const status = error.code === 'unauthenticated' ? 401 :
        error.code === 'needs_reauthorization' ? 403 :
        error.code === 'not_found' ? 404 : 400;
      return jsonError(error.code, status);
    }
    throw error;
  }

  return jsonError('not_found', 404);
}

function readJsonBody(request) {
  const body = request.body;
  if (body === undefined || body === null) return {};
  if (typeof body === 'object' && !Array.isArray(body)) return body;
  if (typeof body === 'string') {
    try { return JSON.parse(body); } catch { deny('invalid_arguments'); }
  }
  deny('invalid_arguments');
}

async function dispatchToolCall(host, request) {
  const token = bearerFromAuthorization(request.headers?.authorization);
  if (!token) deny('unauthenticated');
  const principal = await principalFromToken(host, token);
  const now = host.nowSeconds();
  const payload = readJsonBody(request);
  const name = payload.name;
  const args = payload.arguments && typeof payload.arguments === 'object' ?
    payload.arguments : {};

  // Reject model-supplied principal/owner fields at the transport edge.
  for (const key of Object.keys(payload)) {
    if (!['name', 'arguments'].includes(key)) deny('invalid_arguments');
  }
  for (const key of Object.keys(args)) {
    if (['authenticated', 'subject', 'linkedOwner', 'audience', 'owner_id',
      'githubUserId', 'cloudflareAccountId', 'access_token', 'refresh_token']
      .includes(key))
      deny('invalid_arguments');
  }

  const call = validateToolCall({name, arguments: args}, principal, {nowSeconds: now});
  const result = await runToolCall(host, principal, call, now);
  const current = await principalFromToken(host, token);
  const before = principal.linkedOwner;
  const after = current.linkedOwner;
  if (current.subject !== principal.subject || current.clientId !== principal.clientId ||
      before?.githubUserId !== after?.githubUserId ||
      before?.cloudflareAccountId !== after?.cloudflareAccountId ||
      before?.authorizationEpoch !== after?.authorizationEpoch ||
      before?.reauthorized !== after?.reauthorized)
    deny('needs_reauthorization');
  return result;
}

async function runToolCall(host, principal, call, now) {
  if (call.name === 'get_connection_status') {
    return jsonOk({
      linked: Boolean(call.scope.owner),
      subject: call.scope.subject,
      ...(call.scope.owner ? {
        github_user_id: call.scope.owner.githubUserId,
        cloudflare_account_id: call.scope.owner.cloudflareAccountId,
        authorization_epoch: call.scope.owner.authorizationEpoch
      } : {})
    });
  }

  if (call.name === 'start_connect_accounts') {
    const challenge = await host.links.createLinkChallenge({
      subject: principal.subject,
      clientId: principal.clientId,
      nowSeconds: now
    });
    return jsonOk({
      state: 'needs_browser_link',
      challenge_id: challenge.id,
      expires_at: challenge.expiresAt,
      action: 'open_hosted_onboarding',
      action_url: assertSafeBrowserHandoff(
        `${BROWSER_ORIGIN}/agent-link?challenge_id=${challenge.id}`
      )
      // No OAuth state, codes, or expected IDs returned to the model.
    });
  }

  if (call.name === 'list_sites')
    return jsonOk({sites: await host.sites.listSites(call.scope)});

  if (call.name === 'get_site')
    return jsonOk(await host.sites.getSite(call.scope, call.arguments.site_id));

  if (call.name === 'prepare_site')
    return jsonOk(await host.sites.prepareSite(call.scope, call.arguments.site_spec, {
      nowSeconds: now
    }));

  if (call.name === 'prepare_site_update') {
    if (!host.currentCommitSha || !host.currentRepositoryId)
      return jsonError('not_implemented', 501);
    return jsonOk(await host.sites.prepareSiteUpdate(call.scope, {
      siteId: call.arguments.site_id,
      baseCommitSha: call.arguments.base_commit_sha,
      changes: call.arguments.changes
    }, {
      nowSeconds: now,
      currentCommitSha: host.currentCommitSha,
      currentRepositoryId: host.currentRepositoryId
    }));
  }

  if (call.name === 'get_exact_preview')
    return jsonOk(await host.sites.getExactPreview(call.scope, call.arguments.draft_id, {
      nowSeconds: now
    }));

  if (call.name === 'request_explicit_approval')
    return jsonOk(await host.sites.requestApproval(call.scope, {
      draftId: call.arguments.draft_id,
      previewSha256: call.arguments.preview_sha256,
      idempotencyKey: call.arguments.idempotency_key
    }, {nowSeconds: now}));

  // Agent drafts approved in onboarding are tracked by draft id (#43 item 5).
  if (['get_job_status', 'verify_publication'].includes(call.name) &&
      DRAFT_ID.test(call.arguments.job_id) && host.onboardingStatus && host.bridgeTicketKey) {
    const record = await draftPublicationRecord(host, call.scope, call.arguments.job_id);
    return jsonOk(publicationStatus(record, call.scope));
  }

  if (call.name === 'get_job_status')
    return jsonOk(await host.jobs.getJob(call.scope, call.arguments.job_id));

  if (call.name === 'verify_publication')
    return jsonOk(await host.jobs.verifyPublication(call.scope, call.arguments.job_id));

  return jsonError('not_implemented', 501);
}

/**
 * Consume a sealed browser link ticket minted by onboarding after real OAuth.
 * Rejects raw `verified` maps (agent forgery surface removed in #71).
 *
 * Ticket-only (no agent Bearer) is the browser/onboarding path: subject and
 * client come from the one-time challenge row, never from the request body.
 */
async function completeBrowserLink(host, request) {
  if (!host.bridgeTicketKey) deny('not_found');
  const now = host.nowSeconds();
  const payload = readJsonBody(request);
  if (typeof payload.ticket !== 'string' || payload.verified !== undefined)
    deny('invalid_link_challenge');
  const opened = await openBrowserLinkTicket(host.bridgeTicketKey, payload.ticket, {
    nowSeconds: now
  });
  const challenge = await host.links.peekChallenge(opened.challengeId);
  if (!challenge || challenge.consumedAt !== null || challenge.expiresAt <= now)
    deny('invalid_link_challenge');

  const token = bearerFromAuthorization(request.headers?.authorization);
  let principal;
  if (token) {
    principal = await principalFromToken(host, token);
    if (principal.subject !== challenge.subject ||
        principal.clientId !== challenge.clientId)
      deny('invalid_link_challenge');
  } else {
    const link = await host.links.getLink(challenge.subject, challenge.clientId);
    principal = {
      authenticated: true,
      audience: BRIDGE_AUDIENCE,
      subject: challenge.subject,
      clientId: challenge.clientId,
      expiresAt: now + 120,
      linkedOwner: link ? {
        githubUserId: link.githubUserId,
        cloudflareAccountId: link.cloudflareAccountId,
        authorizationEpoch: link.authorizationEpoch,
        reauthorized: link.reauthorized === true
      } : null
    };
  }

  const record = await host.links.consumeLinkChallenge({
    challengeId: opened.challengeId,
    verifiedIdentity: {
      githubUserId: opened.githubUserId,
      cloudflareAccountId: opened.cloudflareAccountId
    },
    principal,
    nowSeconds: now
  });
  return jsonOk({
    linked: true,
    github_user_id: record.githubUserId,
    cloudflare_account_id: record.cloudflareAccountId,
    authorization_epoch: record.authorizationEpoch
  });
}

