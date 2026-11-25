// Cloudflare Web Analytics for launched Pages sites (on by default, owner can opt out before approval).
// A Web Analytics site is created in the customer's account and its tag/token are set on the Pages
// project's build_config, so Pages adds the beacon on deploy and the repository keeps the exact
// approved bytes. Needs the Cloudflare "Account Settings Write" scope.
// https://developers.cloudflare.com/api/resources/rum/subresources/site_info/methods/create/

export const ANALYTICS_SCRIPT_ORIGIN = 'https://static.cloudflareinsights.com';
export const ANALYTICS_CONNECT_ORIGIN = 'https://cloudflareinsights.com';
const ID = /^[a-f0-9]{32}$/i;

const siteHost = site => site?.host ?? site?.ruleset?.zone_name;
const usable = site => site && typeof site.site_tag === 'string' && ID.test(site.site_tag)
  && typeof site.site_token === 'string' && ID.test(site.site_token);

/** Reuse this host's Web Analytics site, or create it. `api.cloudflare(path, {method, body})` is the provider helper. */
export async function ensureWebAnalyticsSite(api, accountId, host) {
  if (!ID.test(accountId || '') || !/^[a-z0-9-]+\.pages\.dev$/.test(host || '')) throw Error('Invalid Web Analytics target');
  const base = '/accounts/' + encodeURIComponent(accountId) + '/rum/site_info';
  // Reconcile first so a retried launch never registers the same host twice.
  // shortcut: reads the first 100 sites only; page through the list if accounts with more appear.
  const listed = await api.cloudflare(base + '/list?per_page=100');
  const existing = (Array.isArray(listed) ? listed : []).find(site => siteHost(site) === host);
  const site = existing ?? await api.cloudflare(base, { method: 'POST', body: { host, auto_install: false } });
  if (!usable(site)) throw Error('Cloudflare did not return a usable Web Analytics site');
  return { tag: site.site_tag.toLowerCase(), token: site.site_token.toLowerCase() };
}

export function analyticsBuildConfig(beacon) {
  return beacon ? { web_analytics_tag: beacon.tag, web_analytics_token: beacon.token } : {};
}

/** The Pages project's own beacon token, or null. */
export function projectBeaconToken(project) {
  const token = project?.build_config?.web_analytics_token;
  return typeof token === 'string' && ID.test(token) ? token.toLowerCase() : null;
}

const decoder = new TextDecoder('utf-8', { fatal: true });
const BEACON = /<script\b[^>]*>\s*<\/script>/gi;
const COMMENT = /^\s*<!--\s*Cloudflare (?:Pages|Web) Analytics\s*-->/i;
const COMMENT_END = /<!--\s*(?:End )?Cloudflare (?:Pages|Web) Analytics\s*-->\s*$/i;

/**
 * Remove the one beacon Pages injects for this project's own token, so served HTML can be compared
 * with the approved bytes. Any other script, or a beacon with a different token, is left in place.
 * Returns candidate byte arrays (with and without the whitespace around the beacon).
 */
export function withoutProjectBeacon(bytes, token) {
  if (!token || !ID.test(token)) return [];
  let text;
  try { text = decoder.decode(bytes); } catch { return []; }
  const matches = [...text.matchAll(BEACON)].filter(([tag]) =>
    tag.includes(ANALYTICS_SCRIPT_ORIGIN + '/beacon.min.js') && new RegExp('"token"\\s*:\\s*"' + token + '"', 'i').test(tag));
  if (matches.length !== 1) return [];
  const [{ 0: tag, index }] = matches;
  let start = index, end = index + tag.length;
  const after = text.slice(end).match(COMMENT);
  if (after) end += after[0].length;
  const before = text.slice(0, start).match(COMMENT_END);
  if (before) start -= before[0].length;
  const encode = value => new TextEncoder().encode(value);
  const tight = text.slice(0, start).replace(/\s+$/, '') + text.slice(end).replace(/^\s+/, '');
  return [encode(text.slice(0, start) + text.slice(end)), encode(tight),
    encode(text.slice(0, start).replace(/\s+$/, '') + text.slice(end)),
    encode(text.slice(0, start) + text.slice(end).replace(/^\s+/, ''))];
}

export function sameBytes(left, right) {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

/** True when `served` equals `expected` exactly, or after removing only this project's Pages beacon. */
export function matchesApprovedBytes(served, expected, token) {
  return sameBytes(served, expected) || withoutProjectBeacon(served, token).some(candidate => sameBytes(candidate, expected));
}
