// Cloudflare Access JWT validation for the customer-owned assistant (threat model #3; ADR-001).
// The Worker checks the token itself on every request instead of trusting the edge alone.
import { base64Decode } from '../imported/bytes.mjs';

const b64url = text => base64Decode(String(text).replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '='));
const json = part => JSON.parse(new TextDecoder().decode(b64url(part)));

/** Certs cache shared across requests in one isolate. Refetched once when an unknown `kid` appears (keys rotate every 6 weeks). */
export function accessKeyCache({ fetchFn = fetch } = {}) {
  let keys = null;
  const load = async teamDomain => {
    const response = await fetchFn('https://' + teamDomain + '/cdn-cgi/access/certs', { redirect: 'manual' });
    if (!response.ok) throw Error('access_certs_unavailable');
    const body = await response.json();
    keys = new Map((Array.isArray(body?.keys) ? body.keys : []).filter(k => k?.kty === 'RSA' && typeof k.kid === 'string').map(k => [k.kid, k]));
  };
  return {
    async key(teamDomain, kid) {
      if (!keys || !keys.has(kid)) await load(teamDomain);
      const jwk = keys.get(kid);
      return jwk ? crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']) : null;
    }
  };
}

/** Returns the verified claims, or null for any failure. Never throws on a bad token. */
export async function verifyAccessJwt(token, { teamDomain, aud, cache, now = () => Date.now() }) {
  if (typeof token !== 'string' || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token) || !teamDomain || !aud) return null;
  const [h, p, s] = token.split('.');
  let header, claims;
  try { header = json(h); claims = json(p); } catch { return null; }
  if (header?.alg !== 'RS256' || typeof header.kid !== 'string') return null;
  let key;
  try { key = await cache.key(teamDomain, header.kid); } catch { return null; }
  if (!key) return null;
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(s), new TextEncoder().encode(h + '.' + p));
  if (!ok) return null;
  const seconds = Math.floor(now() / 1000);
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== 'https://' + teamDomain || !audiences.includes(aud)) return null;
  if (typeof claims.exp !== 'number' || claims.exp <= seconds) return null;
  if (typeof claims.nbf === 'number' && claims.nbf > seconds) return null;
  if (typeof claims.sub !== 'string' || !claims.sub) return null;
  return claims;
}
