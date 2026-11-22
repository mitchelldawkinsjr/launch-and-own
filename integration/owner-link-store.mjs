/**
 * Adapter-shaped owner-link + challenge persistence for the shared agent bridge.
 * MemoryStore is for tests only. A future D1-backed adapter must keep the same
 * fail-closed semantics (one-time challenge consume, pinned reconnect IDs).
 */
import {randomBytes} from 'node:crypto';
import {
  BridgeContractError, assertLinkChallenge, assertTrustedPrincipal
} from './tool-contract.mjs';

const deny = code => { throw new BridgeContractError(code); };
const ACCOUNT_ID = /^[a-f0-9]{32}$/i;

function newId(prefix) {
  return prefix + '_' + randomBytes(12).toString('hex');
}

export class MemoryOwnerLinkStore {
  #challenges = new Map();
  #links = new Map(); // key: subject + '\0' + clientId

  linkKey(subject, clientId) {
    return subject + '\0' + clientId;
  }

  getLink(subject, clientId) {
    return this.#links.get(this.linkKey(subject, clientId)) || null;
  }

  /**
   * Create a short-lived one-time challenge bound to subject+client.
   * First-time: expected provider IDs are null.
   * Reconnect: expected IDs must match the stored linked owner.
   */
  createLinkChallenge({subject, clientId, nowSeconds, ttlSeconds = 600}) {
    if (typeof subject !== 'string' || typeof clientId !== 'string' ||
        !Number.isSafeInteger(nowSeconds) || nowSeconds < 0 ||
        !Number.isSafeInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 3600)
      deny('invalid_link_challenge');
    const existing = this.getLink(subject, clientId);
    const challenge = Object.freeze({
      id: newId('link'),
      subject,
      clientId,
      expectedGithubUserId: existing ? existing.githubUserId : null,
      expectedCloudflareAccountId: existing ? existing.cloudflareAccountId : null,
      expiresAt: nowSeconds + ttlSeconds,
      consumedAt: null
    });
    this.#challenges.set(challenge.id, {...challenge});
    // Return a projection without inventing browser OAuth state tokens.
    return Object.freeze({...challenge});
  }

  peekChallenge(id) {
    const row = this.#challenges.get(id);
    return row ? Object.freeze({...row}) : null;
  }

  /**
   * Atomically consume a challenge after browser OAuth verified both providers.
   * Uses assertLinkChallenge so reconnect pins stay fail-closed.
   */
  consumeLinkChallenge({
    challengeId, verifiedIdentity, principal, nowSeconds
  }) {
    const scope = assertTrustedPrincipal(principal, {nowSeconds});
    const row = this.#challenges.get(challengeId);
    if (!row) deny('invalid_link_challenge');
    const challenge = Object.freeze({...row});
    const linked = assertLinkChallenge(challenge, verifiedIdentity, principal, {nowSeconds});
    if (row.consumedAt !== null) deny('invalid_link_challenge');
    row.consumedAt = nowSeconds;
    this.#challenges.set(challengeId, row);

    const prev = this.getLink(scope.subject, principal.clientId);
    const authorizationEpoch = prev ? prev.authorizationEpoch + 1 : 0;
    const record = Object.freeze({
      subject: linked.subject,
      clientId: principal.clientId,
      githubUserId: linked.githubUserId,
      cloudflareAccountId: linked.cloudflareAccountId,
      authorizationEpoch,
      reauthorized: true,
      linkedAt: nowSeconds
    });
    this.#links.set(this.linkKey(scope.subject, principal.clientId), record);
    return record;
  }
}

export function linkedOwnerFromStore(store, subject, clientId) {
  const link = store.getLink(subject, clientId);
  if (!link) return null;
  if (!Number.isSafeInteger(link.githubUserId) || link.githubUserId < 1 ||
      !ACCOUNT_ID.test(String(link.cloudflareAccountId)) ||
      !Number.isSafeInteger(link.authorizationEpoch) ||
      link.reauthorized !== true)
    deny('needs_reauthorization');
  return Object.freeze({
    githubUserId: link.githubUserId,
    cloudflareAccountId: String(link.cloudflareAccountId).toLowerCase(),
    authorizationEpoch: link.authorizationEpoch,
    reauthorized: true
  });
}
