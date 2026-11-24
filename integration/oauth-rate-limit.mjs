import {createHmac} from 'node:crypto';
import {d1Run} from './d1-support.mjs';

const LIMITS = Object.freeze({register: 12, authorize: 30, token: 90, revoke: 30});
const WINDOW_SECONDS = 60;

// Cloudflare supplies the source IP. Hash it into a fixed set of keyed buckets
// so no raw address or unbounded caller-created key is stored in D1.
export async function takeOAuthRequestSlot(request, {db, nowSeconds, rateKey}, route) {
  const source = request.headers.get('cf-connecting-ip');
  const address = source && /^[\da-f:.]{3,45}$/i.test(source) ? source : 'unattributed';
  const hash = createHmac('sha256', rateKey).update('oauth-rate-limit:' + address).digest();
  const bucket = hash.readUInt16BE(0) & 4095;
  const windowStart = Math.floor(nowSeconds / WINDOW_SECONDS) * WINDOW_SECONDS;
  const result = await d1Run(db, 'INSERT INTO bridge_oauth_rate_limits ' +
    '(route, bucket, window_start, hits) VALUES (?, ?, ?, 1) ' +
    'ON CONFLICT(route, bucket) DO UPDATE SET window_start = excluded.window_start, ' +
    'hits = CASE WHEN window_start = excluded.window_start THEN hits + 1 ELSE 1 END ' +
    'WHERE window_start < excluded.window_start OR ' +
    '(window_start = excluded.window_start AND hits < ?)',
  route, bucket, windowStart, LIMITS[route]);
  return result.meta?.changes === 1;
}
