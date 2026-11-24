import { verifyCloudflarePagesAccess } from '../pipeline/cloudflare-oauth.mjs';
import { seal, unseal } from './crypto.mjs';

const API_ORIGIN = 'https://api.cloudflare.com';
const ACCOUNT = /^[a-f0-9]{32}$/;
const TOKEN = /^[a-z0-9._~+/=-]{20,512}$/i;
const PROJECT_PATH = /^\/esp-[a-z0-9]+(?:-[a-z0-9]+)*-site(?:\/deployments)?$/;
const clock = () => Math.floor(Date.now() / 1000);

export class PagesAccessChanged extends Error {
  constructor() { super('Cloudflare Pages access changed'); }
}

function aad(sessionHash, access) {
  return JSON.stringify(['cloudflare-pages-access', sessionHash, access.account_id,
    access.authorization_epoch, access.access_id, access.mode, access.expires_at]);
}

const ownerMatch = `s.id_hash = ? AND s.authorization_epoch = ?
  AND s.github_user_id = ? AND s.cloudflare_account_id = ? AND s.cloudflare_token_ct IS NOT NULL`;
const ownerBindings = session => [session.hash, session.authorization_epoch, session.github_user_id,
  session.cloudflare_account_id];

export async function getPagesAccess(env, session, time = clock()) {
  if (!ACCOUNT.test(session?.cloudflare_account_id || '')) return null;
  return env.DB.prepare(`SELECT p.* FROM onboarding_pages_access p
    JOIN onboarding_sessions s ON s.id_hash = p.session_hash
      AND s.authorization_epoch = p.authorization_epoch AND s.cloudflare_account_id = p.account_id
    WHERE ${ownerMatch} AND s.expires_at > ? AND p.expires_at > ?`)
    .bind(...ownerBindings(session), time, time).first();
}

export async function connectPagesAccess(env, session, { token, mode, fetchFn = fetch }) {
  if (!ACCOUNT.test(session?.cloudflare_account_id || '') || typeof token !== 'string' || !TOKEN.test(token)
      || (mode !== 'read' && mode !== 'edit')) return false;
  const previous = await getPagesAccess(env, session);
  const access = { authorization_epoch: session.authorization_epoch, account_id: session.cloudflare_account_id,
    access_id: crypto.randomUUID(), mode, expires_at: session.expires_at };
  await verifyCloudflarePagesAccess({ accessToken: token, accountId: access.account_id, fetchFn, strict: true });
  const ciphertext = await seal(env.TOKEN_ENCRYPTION_KEY, token, aad(session.hash, access));
  const inserted = await env.DB.prepare(`INSERT INTO onboarding_pages_access
    (session_hash, authorization_epoch, account_id, access_id, mode, token_ct, expires_at)
    SELECT s.id_hash, s.authorization_epoch, s.cloudflare_account_id, ?, ?, ?, s.expires_at
    FROM onboarding_sessions s
    WHERE ${ownerMatch} AND s.expires_at = ? AND s.expires_at > ?
      AND (SELECT access_id FROM onboarding_pages_access WHERE session_hash = s.id_hash) IS ?
    ON CONFLICT(session_hash) DO UPDATE SET authorization_epoch = excluded.authorization_epoch,
      account_id = excluded.account_id, access_id = excluded.access_id, mode = excluded.mode,
      token_ct = excluded.token_ct, expires_at = excluded.expires_at
    RETURNING access_id`)
    .bind(access.access_id, mode, ciphertext, ...ownerBindings(session), access.expires_at, clock(),
      previous?.access_id ?? null).first();
  if (!inserted) throw new PagesAccessChanged();
  return true;
}

export async function removePagesAccess(env, session, accessId) {
  return env.DB.prepare(`DELETE FROM onboarding_pages_access WHERE access_id = ?
    AND session_hash IN (SELECT s.id_hash FROM onboarding_sessions s WHERE ${ownerMatch} AND s.expires_at > ?)`)
    .bind(accessId, ...ownerBindings(session), clock()).run();
}

// Use the supplemental secret only on the selected account's Pages endpoints.
// Other provider calls keep their existing OAuth header and authorization flow.
export async function pagesAccessFetch(env, session, fetchFn, {
  expectedAccessId, allowWrite = false, now = clock
} = {}) {
  const grant = await getPagesAccess(env, session, now());
  if (expectedAccessId !== undefined && grant?.access_id !== expectedAccessId) throw new PagesAccessChanged();
  if (!grant) return { fetchFn, mode: null, async isCurrent() { return true; } };
  const token = await unseal(env.TOKEN_ENCRYPTION_KEY, grant.token_ct, aad(session.hash, grant));
  const accountPath = '/client/v4/accounts/' + grant.account_id + '/pages/';
  const projectsPath = accountPath + 'projects';
  const isCurrent = async () => (await getPagesAccess(env, session, now()))?.access_id === grant.access_id;
  return {
    mode: grant.mode,
    isCurrent,
    async fetchFn(url, options = {}) {
      const target = new URL(url);
      if (target.origin !== API_ORIGIN || !target.pathname.startsWith(accountPath))
        return fetchFn(url, options);
      const suffix = target.pathname.slice(projectsPath.length);
      const projectPath = target.pathname === projectsPath ||
        (target.pathname.startsWith(projectsPath + '/') && PROJECT_PATH.test(suffix));
      const method = (options.method ?? 'GET').toUpperCase();
      const canPost = method === 'POST' && allowWrite && grant.mode === 'edit' &&
        (target.pathname === projectsPath || suffix.endsWith('/deployments'));
      if (!projectPath || target.username || target.password || target.hash || (method !== 'GET' && !canPost))
        throw new Error('Pages request is outside the connected access');
      if (!await isCurrent()) throw new PagesAccessChanged();
      const headers = new Headers(options.headers);
      headers.set('authorization', 'Bearer ' + token);
      return fetchFn(target.href, { ...options, method, headers, redirect: 'manual' });
    }
  };
}
