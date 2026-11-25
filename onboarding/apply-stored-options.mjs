// #121 legacy compatibility module. Direct provider writes from a 0005
// status='stored' row are retired: they lack operator authorization and an
// atomic execution lease. Use executeOwnedStoredOption and the separate 0006
// ledger instead; this intentionally refuses all legacy calls.
export async function applyStoredDomainOption() {
  throw Error('Stored domain reviews cannot authorize a provider mutation; operator execution grant required');
}
export function blockedOptionApplyReason(kind) {
  if (kind === 'domain')
    return 'Reopen your toolkit. Domain attachment now requires a separate operator-approved execution grant.';
  if (kind === 'email')
    return 'Email Routing needs an applied custom domain, verified destination, and separate operator grant; MX remains unchanged.';
  if (kind === 'forms')
    return 'Contact forms need a separate #89 cost/privacy approval and server-side Siteverify before activation.';
  return 'Unknown optional feature.';
}
