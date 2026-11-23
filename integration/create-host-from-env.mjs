/**
 * Build a bridge host from Worker env. Used when BRIDGE_DEPLOYMENT=approved.
 * Requires D1 binding + BRIDGE_TICKET_KEY. Does not mint tickets (onboarding does).
 */
import {createBridgeHost, MemoryAgentTokenStore} from './bridge-transport.mjs';
import {D1OwnerLinkStore} from './d1-owner-link-store.mjs';
import {D1SiteDraftStore} from './d1-site-draft-store.mjs';
import {D1JobPublicationStore} from './d1-job-publication-store.mjs';
import {RESOURCE_URI} from './protected-resource.mjs';

export function createHostFromEnv(env) {
  if (!env?.DB) throw new Error('bridge_missing_d1');
  if (typeof env.BRIDGE_TICKET_KEY !== 'string' ||
      !/^[a-f0-9]{64}$/i.test(env.BRIDGE_TICKET_KEY))
    throw new Error('bridge_missing_ticket_key');
  return createBridgeHost({
    tokens: new MemoryAgentTokenStore(),
    links: new D1OwnerLinkStore(env.DB),
    sites: new D1SiteDraftStore(env.DB),
    jobs: new D1JobPublicationStore(env.DB),
    nowSeconds: () => Math.floor(Date.now() / 1000),
    resourceUri: env.BRIDGE_RESOURCE_URI || RESOURCE_URI,
    bridgeTicketKey: env.BRIDGE_TICKET_KEY
  });
}
