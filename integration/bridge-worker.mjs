/**
 * Isolated Fetch adapter for the shared MCP bridge.
 *
 * Undeployed scaffold: production rollout requires explicit Domain approval,
 * real OAuth resource registration, and D1-backed stores. This module does
 * not edit onboarding/worker.mjs and performs no provider I/O.
 */
import {handleBridgeRequest, createBridgeHost} from './bridge-transport.mjs';
import {createHostFromEnv} from './create-host-from-env.mjs';
import {RESOURCE_METADATA_PATH} from './protected-resource.mjs';
import {handleMcp} from './mcp-jsonrpc.mjs';
import {handleOAuth} from './oauth-server.mjs';

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

async function readBody(request) {
  if (request.method === 'GET' || request.method === 'HEAD') return undefined;
  const type = request.headers.get('content-type') || '';
  if (!type.includes('application/json')) return undefined;
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/**
 * Bind a pre-built host (tests / future Durable Object state) to Fetch.
 */
export function createBridgeFetch(host) {
  return async function fetch(request) {
    const body = await readBody(request);
    if (body === null)
      return toResponse({
        status: 400,
        headers: {'content-type': 'application/json', 'cache-control': 'no-store'},
        body: {error: 'invalid_arguments'}
      });
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
    // Test harness may inject a host. Approved production uses D1 + ticket key.
    let host = env.__bridgeHost;
    if (!host) {
      try {
        host = createHostFromEnv(env);
      } catch {
        host = createBridgeHost({
          nowSeconds: () => Math.floor(Date.now() / 1000)
        });
      }
    }
    const url = new URL(request.url);
    if (url.pathname === '/mcp') return secure(await handleMcp(host, request));
    if (env.DB) {
      const oauth = await handleOAuth(request, {
        db: env.DB, tokens: host.tokens, nowSeconds: host.nowSeconds()
      });
      if (oauth) return secure(oauth);
    }
    // RFC 9728 path-suffixed discovery used by MCP clients for resource /mcp.
    if (url.pathname === RESOURCE_METADATA_PATH + '/mcp')
      request = new Request(new URL(RESOURCE_METADATA_PATH, url), request);
    return createBridgeFetch(host)(request);
  }
};

export {RESOURCE_METADATA_PATH};
