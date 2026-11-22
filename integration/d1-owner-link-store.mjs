/**
 * D1-backed owner-link + challenge store for the MCP bridge.
 */
import {randomBytes} from 'node:crypto';
import {
  BridgeContractError, assertLinkChallenge, assertTrustedPrincipal
} from './tool-contract.mjs';
import {d1First, d1Run} from './d1-support.mjs';

const deny = code => { throw new BridgeContractError(code); };
const ACCOUNT_ID = /^[a-f0-9]{32}$/i;

function newId(prefix) {
  return prefix + '_' + randomBytes(12).toString('hex');
}

function rowToLink(row) {
  if (!row) return null;
  return Object.freeze({
    subject: row.subject,
    clientId: row.client_id,
    githubUserId: row.github_user_id,
    cloudflareAccountId: String(row.cloudflare_account_id).toLowerCase(),
    authorizationEpoch: row.authorization_epoch,
    reauthorized: row.reauthorized === 1,
    linkedAt: row.linked_at
  });
}

function rowToChallenge(row) {
  if (!row) return null;
  return Object.freeze({
    id: row.id,
    subject: row.subject,
    clientId: row.client_id,
    expectedGithubUserId: row.expected_github_user_id,
    expectedCloudflareAccountId: row.expected_cloudflare_account_id,
    expectedAuthorizationEpoch: row.expected_authorization_epoch,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at
  });
}

export class D1OwnerLinkStore {
  constructor(db) {
    this.db = db;
  }

  async getLink(subject, clientId) {
    const row = await d1First(this.db,
      `SELECT * FROM bridge_owner_links WHERE subject = ? AND client_id = ?`,
      subject, clientId);
    return rowToLink(row);
  }

  async createLinkChallenge({subject, clientId, nowSeconds, ttlSeconds = 600}) {
    if (typeof subject !== 'string' || typeof clientId !== 'string' ||
        !Number.isSafeInteger(nowSeconds) || nowSeconds < 0 ||
        !Number.isSafeInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 3600)
      deny('invalid_link_challenge');
    const existing = await this.getLink(subject, clientId);
    const challenge = {
      id: newId('link'),
      subject,
      clientId,
      expectedGithubUserId: existing ? existing.githubUserId : null,
      expectedCloudflareAccountId: existing ? existing.cloudflareAccountId : null,
      expectedAuthorizationEpoch: existing ? existing.authorizationEpoch : null,
      expiresAt: nowSeconds + ttlSeconds,
      consumedAt: null
    };
    await d1Run(this.db, `
      INSERT INTO bridge_link_challenges (
        id, subject, client_id, expected_github_user_id, expected_cloudflare_account_id,
        expected_authorization_epoch, expires_at, consumed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
    challenge.id, challenge.subject, challenge.clientId,
    challenge.expectedGithubUserId, challenge.expectedCloudflareAccountId,
    challenge.expectedAuthorizationEpoch, challenge.expiresAt);
    return Object.freeze({...challenge});
  }

  async peekChallenge(id) {
    return rowToChallenge(await d1First(this.db,
      `SELECT * FROM bridge_link_challenges WHERE id = ?`, id));
  }

  async consumeLinkChallenge({
    challengeId, verifiedIdentity, principal, nowSeconds
  }) {
    const scope = assertTrustedPrincipal(principal, {nowSeconds});
    const row = await d1First(this.db,
      `SELECT * FROM bridge_link_challenges WHERE id = ?`, challengeId);
    if (!row || row.consumed_at !== null) deny('invalid_link_challenge');

    const prev = await this.getLink(scope.subject, principal.clientId);
    if (prev) {
      if (!scope.owner ||
          row.expected_github_user_id !== prev.githubUserId ||
          row.expected_cloudflare_account_id !== prev.cloudflareAccountId ||
          row.expected_authorization_epoch !== prev.authorizationEpoch ||
          scope.owner.authorizationEpoch !== prev.authorizationEpoch)
        deny('invalid_link_challenge');
    } else if (scope.owner || row.expected_github_user_id !== null ||
               row.expected_cloudflare_account_id !== null ||
               row.expected_authorization_epoch !== null) {
      deny('invalid_link_challenge');
    }

    const challenge = rowToChallenge(row);
    const linked = assertLinkChallenge(challenge, verifiedIdentity, principal, {nowSeconds});

    const authorizationEpoch = prev ? prev.authorizationEpoch + 1 : 0;
    // Consume only if still unconsumed; then upsert link (fail closed on races).
    const consumed = await d1Run(this.db, `
      UPDATE bridge_link_challenges SET consumed_at = ?
      WHERE id = ? AND consumed_at IS NULL AND expires_at > ?`,
    nowSeconds, challengeId, nowSeconds);
    if (!consumed.meta?.changes) deny('invalid_link_challenge');

    if (prev) {
      const updated = await d1Run(this.db, `
        UPDATE bridge_owner_links
        SET github_user_id = ?, cloudflare_account_id = ?, authorization_epoch = ?,
            reauthorized = 1, linked_at = ?
        WHERE subject = ? AND client_id = ? AND authorization_epoch = ?`,
      linked.githubUserId, linked.cloudflareAccountId, authorizationEpoch, nowSeconds,
      scope.subject, principal.clientId, prev.authorizationEpoch);
      if (!updated.meta?.changes) deny('invalid_link_challenge');
    } else {
      try {
        await d1Run(this.db, `
          INSERT INTO bridge_owner_links (
            subject, client_id, github_user_id, cloudflare_account_id,
            authorization_epoch, reauthorized, linked_at
          ) VALUES (?, ?, ?, ?, ?, 1, ?)`,
        scope.subject, principal.clientId, linked.githubUserId,
        linked.cloudflareAccountId, authorizationEpoch, nowSeconds);
      } catch {
        deny('invalid_link_challenge');
      }
    }

    return Object.freeze({
      subject: linked.subject,
      clientId: principal.clientId,
      githubUserId: linked.githubUserId,
      cloudflareAccountId: linked.cloudflareAccountId,
      authorizationEpoch,
      reauthorized: true,
      linkedAt: nowSeconds
    });
  }
}

export async function linkedOwnerFromD1(store, subject, clientId) {
  const link = await store.getLink(subject, clientId);
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
