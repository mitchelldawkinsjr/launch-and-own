import { seal, unseal } from './crypto.mjs';
import { isZipArtifact } from './zip-artifacts.mjs';

const domainPattern = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/;
const ticketLifetimeSeconds = 15 * 60;
const aad = origin => `website-zip-preview:${origin}`;
const now = () => Math.floor(Date.now() / 1000);

// ZIP_PREVIEW_DOMAIN "preview.example.com" gives hosts "<id>.preview.example.com" (needs a
// two-level wildcard certificate). A leading-hyphen suffix such as "-zp.example.com" gives
// sibling hosts "<id>-zp.example.com", which a free one-level *.example.com certificate covers.
const suffixPattern = /^-[a-z0-9](?:[a-z0-9-]{0,14}[a-z0-9])?\./;
export function zipPreviewHost(id, domain, externalAssets = false) {
  const label = externalAssets ? id + '-external' : id;
  return domain.startsWith('-') ? label + domain : label + '.' + domain;
}

export function zipPreviewConfigured(env) {
  const domain = env.ZIP_PREVIEW_DOMAIN;
  if (!env.ZIP_ARTIFACTS || typeof domain !== 'string' || domain.length > 216) return false;
  const suffix = domain.startsWith('-');
  const base = suffix ? domain.slice(domain.indexOf('.') + 1) : domain;
  if ((suffix && !suffixPattern.test(domain)) || !domainPattern.test(base)) return false;
  let onboarding;
  try { onboarding = new URL(env.ONBOARDING_ORIGIN).hostname; } catch { return false; }
  // Preview hosts must never equal, contain or sit under the onboarding host.
  const separate = suffix ? !onboarding.endsWith(domain) && !base.endsWith('.' + onboarding) && base !== onboarding
    : onboarding !== domain && !onboarding.endsWith('.' + domain) && !domain.endsWith('.' + onboarding);
  return separate
    && typeof env.ZIP_PREVIEW_KEY === 'string' && /^[a-f0-9]{64}$/i.test(env.ZIP_PREVIEW_KEY)
    && env.ZIP_PREVIEW_KEY.toLowerCase() !== env.TOKEN_ENCRYPTION_KEY?.toLowerCase();
}

export async function createZipPreview(env, artifact, stage, sessionExpiry, { externalAssets = false } = {}) {
  const origin = `https://${zipPreviewHost(artifact.id, env.ZIP_PREVIEW_DOMAIN, externalAssets)}`;
  const expires = Math.min(sessionExpiry, now() + ticketLifetimeSeconds);
  const ticket = await seal(env.ZIP_PREVIEW_KEY, JSON.stringify({ artifact, stage, expires, externalAssets }), aad(origin));
  return { origin, ticket };
}

export async function verifyZipPreview(env, url, ticket) {
  if (!zipPreviewConfigured(env) || url.protocol !== 'https:' || typeof ticket !== 'string'
      || !/^[a-z0-9_-]{1,768}$/i.test(ticket)) return null;
  try {
    const claim = JSON.parse(await unseal(env.ZIP_PREVIEW_KEY, ticket, aad(url.origin)));
    const { externalAssets = false } = claim;
    if (typeof externalAssets !== 'boolean' || !isZipArtifact(claim.artifact)
        || url.host !== zipPreviewHost(claim.artifact.id, env.ZIP_PREVIEW_DOMAIN, externalAssets)
        || (claim.stage !== 'draft' && claim.stage !== 'approved') || !Number.isSafeInteger(claim.expires)
        || claim.expires <= now() || claim.expires > now() + ticketLifetimeSeconds) return null;
    return { ...claim, externalAssets };
  } catch { return null; }
}
