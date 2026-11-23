/**
 * Sealed browser link tickets.
 *
 * Minted only by a trusted onboarding/browser session (server-derived GitHub
 * user + Cloudflare account). Consumed by the bridge Worker. Never accept a
 * raw verified map from an agent bearer.
 */
import {seal, unseal} from '../onboarding/crypto.mjs';
import {BridgeContractError} from './tool-contract.mjs';

const deny = code => { throw new BridgeContractError(code); };
const ACCOUNT_ID = /^[a-f0-9]{32}$/i;
const AAD = 'launch-and-own-bridge-link-ticket:v1';

/**
 * Onboarding follow-up calls this after the customer is signed in with both
 * providers and has selected a Cloudflare account.
 */
export async function mintBrowserLinkTicket(ticketKey, {
  challengeId,
  githubUserId,
  cloudflareAccountId,
  nowSeconds,
  ttlSeconds = 300
}) {
  if (typeof ticketKey !== 'string' || !/^[a-f0-9]{64}$/i.test(ticketKey))
    deny('invalid_link_challenge');
  if (typeof challengeId !== 'string' || !challengeId.startsWith('link_'))
    deny('invalid_link_challenge');
  if (!Number.isSafeInteger(githubUserId) || githubUserId < 1 ||
      !ACCOUNT_ID.test(String(cloudflareAccountId)) ||
      !Number.isSafeInteger(nowSeconds) ||
      !Number.isSafeInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 900)
    deny('invalid_link_challenge');
  const payload = {
    challengeId,
    githubUserId,
    cloudflareAccountId: String(cloudflareAccountId).toLowerCase(),
    expiresAt: nowSeconds + ttlSeconds,
    v: 1
  };
  return seal(ticketKey, JSON.stringify(payload), AAD);
}

export async function openBrowserLinkTicket(ticketKey, ticket, {nowSeconds}) {
  if (typeof ticketKey !== 'string' || typeof ticket !== 'string')
    deny('invalid_link_challenge');
  let payload;
  try {
    payload = JSON.parse(await unseal(ticketKey, ticket, AAD));
  } catch {
    deny('invalid_link_challenge');
  }
  if (!payload || payload.v !== 1 ||
      typeof payload.challengeId !== 'string' ||
      !Number.isSafeInteger(payload.githubUserId) || payload.githubUserId < 1 ||
      !ACCOUNT_ID.test(String(payload.cloudflareAccountId)) ||
      !Number.isSafeInteger(payload.expiresAt) ||
      !Number.isSafeInteger(nowSeconds) ||
      payload.expiresAt <= nowSeconds)
    deny('invalid_link_challenge');
  return Object.freeze({
    challengeId: payload.challengeId,
    githubUserId: payload.githubUserId,
    cloudflareAccountId: String(payload.cloudflareAccountId).toLowerCase(),
    expiresAt: payload.expiresAt
  });
}
