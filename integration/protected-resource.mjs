/**
 * Provisional MCP protected-resource metadata for the future shared bridge.
 * Not a registered production resource. Hosts must replace RESOURCE_URI before
 * any public client registration.
 */
import {BRIDGE_AUDIENCE, BROWSER_ORIGIN, CONTRACT_VERSION} from './tool-contract.mjs';

export const RESOURCE_URI = 'https://onboard.360web.cloud/mcp';
export const RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource';

/** RFC 9728-shaped document for discovery; audience must match transport checks. */
export function protectedResourceMetadata({
  resource = RESOURCE_URI,
  authorizationServers = [BROWSER_ORIGIN],
  scopesSupported = ['launch_and_own.bridge']
} = {}) {
  if (typeof resource !== 'string' || !resource.startsWith('https://'))
    throw new Error('invalid_resource');
  return Object.freeze({
    resource,
    authorization_servers: Object.freeze([...authorizationServers]),
    scopes_supported: Object.freeze([...scopesSupported]),
    bearer_methods_supported: Object.freeze(['header']),
    resource_documentation: BROWSER_ORIGIN + '/',
    // Internal markers for Launch & Own bridge hosts — not MCP protocol fields.
    launch_and_own: Object.freeze({
      contract_version: CONTRACT_VERSION,
      bridge_audience: BRIDGE_AUDIENCE,
      browser_origin: BROWSER_ORIGIN,
      status: 'not_deployed'
    })
  });
}
