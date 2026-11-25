/**
 * Server-to-server handoff between onboarding and the MCP bridge (#43 item 5).
 *
 * Both directions use short-lived tickets sealed with the shared
 * BRIDGE_TICKET_KEY and carry only server-derived owner identity:
 *   - draft:  onboarding (signed-in owner) asks the bridge for an agent draft
 *   - status: bridge (linked agent) asks onboarding how that draft's launch is going
 * A different AAD per purpose stops one ticket being replayed as the other.
 */
import {seal, unseal} from '../onboarding/crypto.mjs';
import {BridgeContractError} from './tool-contract.mjs';

export const DRAFT_ID = /^draft_[a-f0-9]{20}$/;
export const BRIDGE_STATUS_VERSION = 2;
const ACCOUNT_ID = /^[a-f0-9]{32}$/i;
const KEY = /^[a-f0-9]{64}$/i;
const AAD = {draft: 'launch-and-own-bridge-draft-ticket:v1', status: 'launch-and-own-bridge-status-ticket:v1'};
const deny = code => { throw new BridgeContractError(code); };

export async function mintOwnerTicket(key, purpose, {draftId, githubUserId, cloudflareAccountId, nowSeconds}) {
  if (!KEY.test(String(key)) || !AAD[purpose] || !DRAFT_ID.test(String(draftId)) ||
      !Number.isSafeInteger(githubUserId) || githubUserId < 1 ||
      !ACCOUNT_ID.test(String(cloudflareAccountId)) || !Number.isSafeInteger(nowSeconds))
    deny('invalid_handoff');
  return seal(key, JSON.stringify({v: 1, draftId, githubUserId,
    cloudflareAccountId: String(cloudflareAccountId).toLowerCase(), expiresAt: nowSeconds + 60}), AAD[purpose]);
}

export async function openOwnerTicket(key, purpose, ticket, {nowSeconds}) {
  if (!KEY.test(String(key)) || !AAD[purpose] || typeof ticket !== 'string' || ticket.length > 2048)
    deny('invalid_handoff');
  let p;
  try { p = JSON.parse(await unseal(key, ticket, AAD[purpose])); } catch { deny('invalid_handoff'); }
  if (p?.v !== 1 || !DRAFT_ID.test(String(p.draftId)) || !Number.isSafeInteger(p.githubUserId) ||
      p.githubUserId < 1 || !ACCOUNT_ID.test(String(p.cloudflareAccountId)) ||
      !Number.isSafeInteger(p.expiresAt) || p.expiresAt <= nowSeconds)
    deny('invalid_handoff');
  return Object.freeze({draftId: p.draftId, githubUserId: p.githubUserId,
    cloudflareAccountId: p.cloudflareAccountId.toLowerCase()});
}

/** Bridge side: return a prepared create-draft to the owner's onboarding session. */
export async function draftForOnboarding(host, ticket) {
  if (!host.bridgeTicketKey || !host.sites.getDraftRecord) deny('not_found');
  const now = host.nowSeconds();
  const owner = await openOwnerTicket(host.bridgeTicketKey, 'draft', ticket, {nowSeconds: now});
  const draft = await host.sites.getDraftRecord(owner.draftId);
  if (!draft || draft.githubUserId !== owner.githubUserId ||
      String(draft.cloudflareAccountId).toLowerCase() !== owner.cloudflareAccountId)
    deny('not_found');
  if (draft.kind !== 'create' || draft.state !== 'prepared' || draft.expiresAt <= now || !draft.siteSpec)
    deny('stale_preview');
  return {draft_id: draft.id, preview_sha256: draft.previewSha256, site_spec: draft.siteSpec,
    expires_at: draft.expiresAt};
}

/**
 * Bridge side: project a draft's current job state and historical publication
 * evidence from onboarding's launch runner.
 */
export async function draftPublicationRecord(host, scope, draftId) {
  // A fresh request after reconnect can read the same owner's launch history.
  // The transport rechecks the current token and link epoch before returning it.
  const draft = await host.sites.getDraftRecord(draftId);
  if (!draft || draft.subject !== scope.subject || draft.githubUserId !== scope.owner.githubUserId ||
      String(draft.cloudflareAccountId).toLowerCase() !== scope.owner.cloudflareAccountId)
    deny('not_found');
  const ticket = await mintOwnerTicket(host.bridgeTicketKey, 'status', {
    draftId, githubUserId: draft.githubUserId, cloudflareAccountId: draft.cloudflareAccountId,
    nowSeconds: host.nowSeconds()
  });
  let report;
  try { report = await host.onboardingStatus(ticket); }
  catch { deny('onboarding_status_unavailable'); }
  if (report?.handoff_version !== BRIDGE_STATUS_VERSION || report.status === 'live')
    deny('onboarding_status_unavailable');
  return {
    id: draftId, subject: scope.subject, githubUserId: scope.owner.githubUserId,
    cloudflareAccountId: scope.owner.cloudflareAccountId,
    authorizationEpoch: scope.owner.authorizationEpoch,
    status: report.status,
    ...(report.status === 'last_verified' ? {
      lastVerifiedAt: report.last_verified_at, lastVerifiedCommitSha: report.last_verified_commit_sha,
      lastVerifiedHtmlSha256: report.last_verified_html_sha256
    } : {})
  };
}
