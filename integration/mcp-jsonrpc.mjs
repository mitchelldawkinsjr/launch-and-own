/**
 * MCP Streamable HTTP endpoint (JSON responses, no SSE) at POST /mcp.
 * Thin adapter: every tools/call goes through the existing bridge dispatcher,
 * so contract validation, tenant fences and link rules stay in one place.
 */
import {handleBridgeRequest} from './bridge-transport.mjs';
import {RESOURCE_METADATA_PATH} from './protected-resource.mjs';
import {MCP_ORIGIN} from './oauth-server.mjs';
import {MCP_ICON_PATH} from './mcp-icon.mjs';
import {MAX_MCP_BODY_BYTES, readBridgeJson} from './request-body.mjs';

const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

// Public-facing discovery metadata. A custom ChatGPT connection may still
// require the owner to enter its description and upload an icon in the UI.
// Clients can load the PNG from the MCP origin without credentials.
export const SERVER_INFO = Object.freeze({
  name: 'launch-and-own',
  title: 'Launch & Own',
  version: '1.0.0',
  description: 'Build and launch websites you own using ChatGPT, GitHub, and Cloudflare. Create a website draft, preview the exact result, approve publication securely in your browser, and verify when your site is live.',
  websiteUrl: 'https://onboard.360web.cloud',
  icons: Object.freeze([Object.freeze({
    src: MCP_ORIGIN + MCP_ICON_PATH,
    mimeType: 'image/png',
    sizes: Object.freeze(['128x128'])
  })])
});

const siteSpec = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'headline', 'about', 'services'],
  properties: {
    name: {type: 'string', maxLength: 120},
    headline: {type: 'string', maxLength: 180},
    about: {type: 'string', maxLength: 12000},
    services: {type: 'array', maxItems: 6, items: {type: 'string', maxLength: 180}},
    contactEmail: {type: 'string', maxLength: 254},
    theme: {type: 'string', enum: ['ocean', 'forest', 'sunset', 'graphite']}
  }
};
const id = description => ({type: 'string', description});
const obj = (properties = {}, required = []) =>
  ({type: 'object', additionalProperties: false, properties, required});
const readOnly = {readOnlyHint: true, destructiveHint: false};

export const TOOLS = [
  {name: 'get_connection_status', annotations: readOnly, inputSchema: obj(),
    description: 'Check whether this agent session is linked to the customer\'s GitHub and Cloudflare accounts.'},
  {name: 'start_connect_accounts', annotations: {destructiveHint: false}, inputSchema: obj(),
    description: 'Start linking this agent session to the customer\'s accounts. Returns a URL the customer must open and confirm in their own browser. Never ask the customer for tokens.'},
  {name: 'list_sites', annotations: readOnly, inputSchema: obj(),
    description: 'List Launch & Own sites prepared by this linked agent session.'},
  {name: 'get_site', annotations: readOnly, inputSchema: obj({site_id: id('Site id')}, ['site_id']),
    description: 'Get one site owned by the linked customer.'},
  {name: 'prepare_site', annotations: {destructiveHint: false},
    inputSchema: obj({site_spec: siteSpec}, ['site_spec']),
    description: 'Prepare a one-page website draft from structured content. Creates no repository or hosting; returns a draft id and exact preview digest.'},
  {name: 'prepare_site_update', annotations: {destructiveHint: false},
    inputSchema: obj({
      site_id: id('Site id'),
      base_commit_sha: id('40-hex commit the update is based on'),
      changes: obj({
        headline: {type: 'string'}, about: {type: 'string'},
        services: {type: 'array', items: {type: 'string'}}, contactEmail: {type: 'string'}
      })
    }, ['site_id', 'base_commit_sha', 'changes']),
    description: 'Prepare an update draft for an existing site. Not available yet on the hosted bridge.'},
  {name: 'get_exact_preview', annotations: readOnly,
    inputSchema: obj({draft_id: id('Draft id')}, ['draft_id']),
    description: 'Get the SHA-256 of a prepared draft and the review_url where the customer sees the exact page.'},
  {name: 'request_explicit_approval', annotations: {destructiveHint: false},
    inputSchema: obj({
      draft_id: id('Draft id'),
      preview_sha256: id('64-hex preview digest from get_exact_preview'),
      idempotency_key: id('Random key, at least 16 characters')
    }, ['draft_id', 'preview_sha256', 'idempotency_key']),
    description: 'Hand the customer a browser link to review and approve the exact preview. The agent cannot approve or publish on its own.'},
  {name: 'get_job_status', annotations: readOnly,
    inputSchema: obj({job_id: id('Job id')}, ['job_id']),
    description: 'Get publication status. For agent drafts, pass the draft_id as job_id.'},
  {name: 'verify_publication', annotations: readOnly,
    inputSchema: obj({job_id: id('Job id')}, ['job_id']),
    description: 'Read publication verification (job_id = draft_id for agent drafts). Only report a site as live when this returns state live with commit and HTML digests. The last_verified state is a historical check with a Unix timestamp in seconds.'}
];

const HINTS = {
  needs_reauthorization: 'This session is not linked to the customer\'s accounts. Call start_connect_accounts and ask the customer to open the returned URL.',
  invalid_arguments: 'Arguments did not match the tool schema.',
  not_found: 'No such record for this customer.',
  not_implemented: 'This tool is not available on the hosted bridge yet.'
};

const securityJson = (body, status = 200, extra = {}) => new Response(
  body === null ? null : JSON.stringify(body),
  {status, headers: {'content-type': 'application/json', 'cache-control': 'no-store', ...extra}});

const unauthorized = () => securityJson({error: 'unauthenticated'}, 401, {
  'www-authenticate':
    `Bearer resource_metadata="${MCP_ORIGIN}${RESOURCE_METADATA_PATH}", scope="launch_and_own.bridge"`
});

const rpcResult = (id, result) => securityJson({jsonrpc: '2.0', id, result});
const rpcError = (id, code, message, status = 200) =>
  securityJson({jsonrpc: '2.0', id: id ?? null, error: {code, message}}, status);

function validRequestId(id) {
  return id === undefined || id === null ||
    (typeof id === 'string' && id.length <= 128) || Number.isSafeInteger(id);
}

export function acceptsMcpOrigin(request, resourceUri) {
  const origin = request.headers.get('origin');
  return origin === null || origin === new URL(resourceUri).origin;
}

function bearer(request) {
  const match = /^Bearer ([A-Za-z0-9_-]{1,256})$/.exec(request.headers.get('authorization') || '');
  return match ? match[1] : null;
}

export async function handleMcp(host, request) {
  if (!acceptsMcpOrigin(request, host.resourceUri))
    return securityJson({error: 'forbidden_origin'}, 403);
  if (request.method !== 'POST')
    return securityJson({error: 'method_not_allowed'}, 405, {allow: 'POST'});
  const token = bearer(request);
  if (!token || !(await host.tokens.lookup(token, {nowSeconds: host.nowSeconds()})))
    return unauthorized();

  let msg;
  try { msg = await readBridgeJson(request, MAX_MCP_BODY_BYTES); }
  catch (error) {
    if (error.status === 413) return rpcError(null, -32600, 'Request body too large', 413);
    if (error.status === 415) return rpcError(null, -32600, 'Expected application/json', 415);
    return rpcError(null, -32700, 'Parse error');
  }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0' ||
      typeof msg.method !== 'string' || !validRequestId(msg.id))
    return rpcError(validRequestId(msg?.id) ? msg?.id : null, -32600, 'Invalid Request');
  // Notifications (no id) and client responses get no body.
  if (msg.id === undefined) return securityJson(null, 202);

  const params = msg.params && typeof msg.params === 'object' ? msg.params : {};
  switch (msg.method) {
  case 'initialize':
    return rpcResult(msg.id, {
      protocolVersion: VERSIONS.includes(params.protocolVersion) ?
        params.protocolVersion : VERSIONS[1],
      capabilities: {tools: {listChanged: false}},
      serverInfo: SERVER_INFO,
      instructions: 'Launch & Own publishes customer-owned websites. Never ask for or accept GitHub/Cloudflare tokens in chat. Link accounts with start_connect_accounts. Publishing needs the customer\'s explicit approval in the browser; never claim a site is live unless verify_publication says so.'
    });
  case 'ping':
    return rpcResult(msg.id, {});
  case 'tools/list':
    return rpcResult(msg.id, {tools: TOOLS});
  case 'tools/call': {
    if (typeof params.name !== 'string') return rpcError(msg.id, -32602, 'Invalid params');
    const result = await handleBridgeRequest(host, {
      method: 'POST',
      url: '/mcp/tools/call',
      headers: {authorization: 'Bearer ' + token},
      body: {name: params.name, arguments: params.arguments ?? {}}
    });
    if (result.status === 401) return unauthorized();
    if (result.body?.error === 'unknown_tool')
      return rpcError(msg.id, -32602, 'Unknown tool');
    if (result.status >= 400) {
      const code = result.body?.error || 'error';
      return rpcResult(msg.id, {isError: true, content: [{type: 'text',
        text: code + (HINTS[code] ? ': ' + HINTS[code] : '')}]});
    }
    return rpcResult(msg.id, {
      content: [{type: 'text', text: JSON.stringify(result.body)}],
      structuredContent: result.body
    });
  }
  default:
    return rpcError(msg.id, -32601, 'Method not found');
  }
}
