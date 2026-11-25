/**
 * Isolated Fetch adapter for the shared MCP bridge.
 *
 * The hosted bridge requires explicit deployment approval and persistent
 * authorization state. Test hosts can be injected by the runner.
 */
import {handleBridgeRequest} from './bridge-transport.mjs';
import {createHostFromEnv} from './create-host-from-env.mjs';
import {RESOURCE_METADATA_PATH} from './protected-resource.mjs';
import {acceptsMcpOrigin, handleMcp} from './mcp-jsonrpc.mjs';
import {MAX_BRIDGE_TICKET_BODY_BYTES, MAX_MCP_BODY_BYTES, readBridgeJson} from './request-body.mjs';
import {handleOAuth} from './oauth-server.mjs';
import {MCP_ICON_PATH, MCP_ICON_PNG_BASE64} from './mcp-icon.mjs';

const mcpIcon = Uint8Array.from(atob(MCP_ICON_PNG_BASE64), char => char.charCodeAt(0));

const securityHeaders = Object.freeze({
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'"
});

/** Add default security headers without overriding route-specific ones. */
function secure(response) {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(securityHeaders))
    if (!headers.has(k)) headers.set(k, v);
  return new Response(response.body, {status: response.status, headers});
}

function toResponse(result) {
  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: {...securityHeaders, ...result.headers}
  });
}

const bodyLimits = new Map([
  ['/mcp/tools/call', MAX_MCP_BODY_BYTES],
  ['/mcp/link/browser', MAX_BRIDGE_TICKET_BODY_BYTES],
  ['/mcp/internal/draft', MAX_BRIDGE_TICKET_BODY_BYTES]
]);

function bridgeError(status, error) {
  return toResponse({status, headers: {'content-type': 'application/json'}, body: {error}});
}

/**
 * Bind a pre-built host (tests / future Durable Object state) to Fetch.
 */
export function createBridgeFetch(host) {
  return async function fetch(request) {
    const path = new URL(request.url).pathname;
    const limit = bodyLimits.get(path);
    let body;
    if (request.method === 'POST' && limit) {
      if (!acceptsMcpOrigin(request, host.resourceUri)) return bridgeError(403, 'forbidden_origin');
      try { body = await readBridgeJson(request, limit); }
      catch (error) {
        return bridgeError(error.status ?? 400, error.status === 413
          ? 'request_too_large' : 'invalid_arguments');
      }
    }
    const headers = Object.fromEntries(request.headers.entries());
    return toResponse(await handleBridgeRequest(host, {
      method: request.method,
      url: request.url,
      headers,
      body
    }));
  };
}

/**
 * Worker entry. Refuses traffic unless BRIDGE_DEPLOYMENT=approved.
 * Approved hosts use D1 for links/sites/drafts/jobs via createHostFromEnv.
 */
export default {
  async fetch(request, env) {
    if (env?.BRIDGE_DEPLOYMENT !== 'approved') {
      return new Response(JSON.stringify({
        error: 'not_deployed',
        detail: 'Launch & Own MCP bridge Worker is not approved for production.'
      }), {
        status: 503,
        headers: {...securityHeaders, 'content-type': 'application/json'}
      });
    }
    const url = new URL(request.url);
    if (url.pathname === MCP_ICON_PATH && (request.method === 'GET' || request.method === 'HEAD')) {
      return secure(new Response(request.method === 'HEAD' ? null : mcpIcon, {
        headers: {'content-type': 'image/png', 'cache-control': 'public, max-age=86400'}
      }));
    }
    try {
      const host = env.__bridgeHost ?? createHostFromEnv(env);
      if (url.pathname === '/mcp') return secure(await handleMcp(host, request));
      if (env.DB) {
        const oauth = await handleOAuth(request, {
          db: env.DB, tokens: host.tokens, nowSeconds: host.nowSeconds(),
          rateKey: host.bridgeTicketKey
        });
        if (oauth) return secure(oauth);
      }
      // RFC 9728 path-suffixed discovery for the /mcp resource.
      if (url.pathname === RESOURCE_METADATA_PATH + '/mcp')
        request = new Request(new URL(RESOURCE_METADATA_PATH, url), request);
      return await createBridgeFetch(host)(request);
    } catch {
      return bridgeError(503, 'service_unavailable');
    }
  }
};
