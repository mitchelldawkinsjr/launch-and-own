// Customer-owned GitHub App credentials (ADR-002 A3): App JWT + one-hour installation tokens,
// each restricted to the single website repository and the two permissions the assistant needs.
import { base64Decode, base64Encode } from '../imported/bytes.mjs';
import { ImportedEditError } from '../imported/errors.mjs';

export const TOKEN_PERMISSIONS = Object.freeze({ contents: 'write', pull_requests: 'write' });

const b64url = bytes => base64Encode(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const derLength = n => n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : n < 0x10000 ? [0x82, n >> 8, n & 0xff] : [0x83, n >> 16, (n >> 8) & 0xff, n & 0xff];
const der = (tag, body) => Uint8Array.from([tag, ...derLength(body.length), ...body]);

/** GitHub downloads PKCS#1 ("RSA PRIVATE KEY"); WebCrypto imports PKCS#8. Wrap PKCS#1 in a PKCS#8 envelope. */
export function pkcs8FromPem(pem) {
  const match = /-----BEGIN (RSA )?PRIVATE KEY-----([\s\S]+?)-----END (RSA )?PRIVATE KEY-----/.exec(String(pem));
  if (!match || Boolean(match[1]) !== Boolean(match[3])) throw Error('invalid_private_key');
  const body = base64Decode(match[2]);
  if (!match[1]) return body;
  const rsaAlgorithm = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  return der(0x30, [0x02, 0x01, 0x00, ...rsaAlgorithm, ...der(0x04, [...body])]);
}

/** App JWT: RS256, iat 60 s in the past, exp 9 minutes ahead (GitHub allows at most 10). */
export async function appJwt({ appId, privateKeyPem, now = () => Date.now() }) {
  if (!/^\d+$/.test(String(appId || ''))) throw Error('invalid_app_id');
  const key = await crypto.subtle.importKey('pkcs8', pkcs8FromPem(privateKeyPem), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const seconds = Math.floor(now() / 1000);
  const encode = value => b64url(new TextEncoder().encode(JSON.stringify(value)));
  const input = encode({ alg: 'RS256', typ: 'JWT' }) + '.' + encode({ iat: seconds - 60, exp: seconds + 540, iss: String(appId) });
  const signature = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(input)));
  return input + '.' + b64url(signature);
}

/**
 * Mint a token for one approved operation. Keep it in memory only and let it expire.
 * 401/403/404 means the App, its key, or the installation was revoked: fail closed, no retry.
 */
export async function mintInstallationToken({ appId, privateKeyPem, installationId, repositoryId, fetchFn = fetch, now }) {
  if (!/^\d+$/.test(String(installationId || '')) || !Number.isSafeInteger(repositoryId) || repositoryId <= 0) throw Error('invalid_installation_target');
  const jwt = await appJwt({ appId, privateKeyPem, now });
  const response = await fetchFn('https://api.github.com/app/installations/' + installationId + '/access_tokens', {
    method: 'POST',
    redirect: 'manual',
    headers: { authorization: 'Bearer ' + jwt, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'launch-and-own-assistant', 'content-type': 'application/json' },
    body: JSON.stringify({ repository_ids: [repositoryId], permissions: TOKEN_PERMISSIONS })
  });
  if (response.status === 401 || response.status === 403 || response.status === 404) throw new ImportedEditError('credentials_revoked');
  if (response.status !== 201) throw Error('github_http_' + response.status);
  const body = await response.json();
  // Token format varies (ghs_APPID_JWT since 2026-04), so check type and presence, never length.
  if (typeof body?.token !== 'string' || !body.token) throw Error('github_token_missing');
  const repos = Array.isArray(body.repositories) ? body.repositories : null;
  if (repos && (repos.length !== 1 || repos[0]?.id !== repositoryId)) throw Error('github_token_scope_mismatch');
  for (const [name, level] of Object.entries(body.permissions || {})) {
    if (name !== 'metadata' && TOKEN_PERMISSIONS[name] !== level) throw Error('github_token_scope_mismatch');
  }
  return { token: body.token, expiresAt: body.expires_at };
}
