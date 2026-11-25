/**
 * D1-backed opaque agent bearer store. Raw tokens are never written to D1 —
 * only SHA-256 hashes. Issue returns the raw token once to the trusted issuer.
 */
import {createHash, randomBytes} from 'node:crypto';
import {BRIDGE_AUDIENCE, BridgeContractError} from './tool-contract.mjs';
import {d1First, d1Run} from './d1-support.mjs';

const deny = code => { throw new BridgeContractError(code); };

function hashToken(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export class D1AgentTokenStore {
  constructor(db) {
    this.db = db;
  }

  prepareIssue({subject, clientId, nowSeconds, ttlSeconds = 3600, audience = BRIDGE_AUDIENCE},
    {afterClaim = false} = {}) {
    if (typeof subject !== 'string' || typeof clientId !== 'string' ||
        !Number.isSafeInteger(nowSeconds) || audience !== BRIDGE_AUDIENCE)
      deny('unauthenticated');
    const token = 'agt_' + randomBytes(24).toString('hex');
    const expiresAt = nowSeconds + ttlSeconds;
    const statement = this.db.prepare(`
      INSERT INTO bridge_agent_tokens (
        token_hash, subject, client_id, audience, expires_at, revoked_at
      ) SELECT ?, ?, ?, ?, ?, NULL ${afterClaim ? 'WHERE changes() = 1' : ''}`)
      .bind(hashToken(token), subject, clientId, audience, expiresAt);
    return {token, statement};
  }

  async issue(options) {
    const issue = this.prepareIssue(options);
    await issue.statement.run();
    return issue.token;
  }

  async lookup(token, {nowSeconds, expectedAudience = BRIDGE_AUDIENCE}) {
    if (typeof token !== 'string' || !token.startsWith('agt_') ||
        !Number.isSafeInteger(nowSeconds))
      return null;
    const row = await d1First(this.db, `
      SELECT subject, client_id, audience, expires_at, revoked_at
      FROM bridge_agent_tokens WHERE token_hash = ?`, hashToken(token));
    if (!row || row.revoked_at !== null || row.audience !== expectedAudience ||
        row.expires_at <= nowSeconds)
      return null;
    return Object.freeze({
      subject: row.subject,
      clientId: row.client_id,
      audience: row.audience,
      expiresAt: row.expires_at
    });
  }

  async revoke(token) {
    if (typeof token !== 'string' || !token.startsWith('agt_')) return;
    const now = Math.floor(Date.now() / 1000);
    await d1Run(this.db, `
      UPDATE bridge_agent_tokens SET revoked_at = ?
      WHERE token_hash = ? AND revoked_at IS NULL`,
    now, hashToken(token));
  }
}
