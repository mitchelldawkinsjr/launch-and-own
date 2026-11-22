import { seal, unseal } from './crypto.mjs';
import { isZipArtifact } from './zip-artifacts.mjs';

const domainPattern = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/;
const ticketLifetimeSeconds = 15 * 60;
const aad = origin => `website-zip-preview:${origin}`;
const now = () => Math.floor(Date.now() / 1000);

export function zipPreviewConfigured(env) {
  const domain = env.ZIP_PREVIEW_DOMAIN;
  if (!env.ZIP_ARTIFACTS || typeof domain !== 'string' || domain.length > 216 || !domainPattern.test(domain)) return false;
  let onboarding;
  try { onboarding = new URL(env.ONBOARDING_ORIGIN).hostname; } catch { return false; }
  return onboarding !== domain && !onboarding.endsWith('.' + domain) && !domain.endsWith('.' + onboarding)
    && typeof env.ZIP_PREVIEW_KEY === 'string' && /^[a-f0-9]{64}$/i.test(env.ZIP_PREVIEW_KEY)
    && env.ZIP_PREVIEW_KEY.toLowerCase() !== env.TOKEN_ENCRYPTION_KEY?.toLowerCase();
}

export async function createZipPreview(env, artifact, stage, sessionExpiry) {
  const origin = `https://${artifact.id}.${env.ZIP_PREVIEW_DOMAIN}`;
  const expires = Math.min(sessionExpiry, now() + ticketLifetimeSeconds);
  const ticket = await seal(env.ZIP_PREVIEW_KEY, JSON.stringify({ artifact, stage, expires }), aad(origin));
  return { origin, ticket };
}

export async function verifyZipPreview(env, url, ticket) {
  if (!zipPreviewConfigured(env) || url.protocol !== 'https:' || typeof ticket !== 'string'
      || !/^[a-z0-9_-]{1,768}$/i.test(ticket)) return null;
  try {
    const claim = JSON.parse(await unseal(env.ZIP_PREVIEW_KEY, ticket, aad(url.origin)));
    if (!isZipArtifact(claim.artifact) || url.host !== `${claim.artifact.id}.${env.ZIP_PREVIEW_DOMAIN}`
        || (claim.stage !== 'draft' && claim.stage !== 'approved') || !Number.isSafeInteger(claim.expires)
        || claim.expires <= now() || claim.expires > now() + ticketLifetimeSeconds) return null;
    return claim;
  } catch { return null; }
}
