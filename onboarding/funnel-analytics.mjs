/** Server-side onboard funnel events (Workers Analytics Engine). No cookies, no Google, no PII.
 * blobs: [step, country, path] · doubles: [1] · indexes: ['onboard']
 */
export const FUNNEL_STEPS = Object.freeze([
  'land',
  'start_github',
  'github_ok',
  'start_cloudflare',
  'cloudflare_ok',
  'account_selected',
  'preview',
  'zip_preview',
  'approve'
]);

const STEP_SET = new Set(FUNNEL_STEPS);
const COUNTRY = /^[A-Z]{2}$/;

/** Best-effort write. Missing binding or a bad step is a no-op so requests never fail for analytics. */
export function recordFunnel(env, step, {country = '', path = ''} = {}) {
  if (!STEP_SET.has(step)) return false;
  const ae = env?.FUNNEL;
  if (!ae || typeof ae.writeDataPoint !== 'function') return false;
  const cc = COUNTRY.test(country) ? country : 'XX';
  const p = typeof path === 'string' ? path.slice(0, 120) : '';
  try {
    ae.writeDataPoint({
      blobs: [step, cc, p],
      doubles: [1],
      indexes: ['onboard']
    });
    return true;
  } catch {
    return false;
  }
}

export function countryFromRequest(request) {
  const c = request?.cf?.country;
  return typeof c === 'string' && COUNTRY.test(c) ? c : '';
}
