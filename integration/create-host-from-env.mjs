/**
 * Build a bridge host from Worker env. Used when BRIDGE_DEPLOYMENT=approved.
 * Requires D1 binding + BRIDGE_TICKET_KEY. Does not mint tickets (onboarding does).
 */
import {createBridgeHost} from './bridge-transport.mjs';
import {D1AgentTokenStore} from './d1-agent-token-store.mjs';
import {D1OwnerLinkStore} from './d1-owner-link-store.mjs';
import {D1SiteDraftStore} from './d1-site-draft-store.mjs';
import {D1JobPublicationStore} from './d1-job-publication-store.mjs';
import {RESOURCE_URI} from './protected-resource.mjs';
import {BROWSER_ORIGIN} from './tool-contract.mjs';
import {MAX_BRIDGE_TICKET_BODY_BYTES, readBridgeJson} from './request-body.mjs';

export function createHostFromEnv(env) {
  if (typeof env?.DB?.prepare !== 'function' || typeof env.DB.batch !== 'function')
    throw new Error('bridge_missing_d1');
  if (env.ONBOARDING_ORIGIN && env.ONBOARDING_ORIGIN !== BROWSER_ORIGIN)
    throw new Error('bridge_invalid_onboarding_origin');
  if (typeof env.BRIDGE_TICKET_KEY !== 'string' ||
      !/^[a-f0-9]{64}$/i.test(env.BRIDGE_TICKET_KEY))
    throw new Error('bridge_missing_ticket_key');
  return createBridgeHost({
    tokens: new D1AgentTokenStore(env.DB),
    links: new D1OwnerLinkStore(env.DB),
    sites: new D1SiteDraftStore(env.DB),
    jobs: new D1JobPublicationStore(env.DB),
    nowSeconds: () => Math.floor(Date.now() / 1000),
    resourceUri: env.BRIDGE_RESOURCE_URI || RESOURCE_URI,
    bridgeTicketKey: env.BRIDGE_TICKET_KEY,
    onboardingStatus: env.ONBOARDING_ORIGIN ? async ticket => {
      const res = await fetch(env.ONBOARDING_ORIGIN + '/internal/bridge-launch-status', {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(8000),
        headers: {'content-type': 'application/json', 'user-agent': 'launch-and-own-bridge'},
        body: JSON.stringify({ticket})
      });
      if (!res.ok) throw new Error('onboarding_status_unavailable');
      return readBridgeJson(res, MAX_BRIDGE_TICKET_BODY_BYTES);
    } : null
  });
}
