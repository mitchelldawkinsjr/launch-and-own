// An owner may execute only an already separately authorized D1 execution grant.
// The ordinary /site-options consent POST cannot reach this function.
import { consumeStoredToolkitApproval } from '../pipeline/approved-extension-consumer.mjs';
import { createCloudflareExtensionProvider } from '../pipeline/cloudflare-extension-provider.mjs';
import { getFreshAccessToken } from './token-lifecycle.mjs';
import {
  createD1OptionExecutionStore, isOptionExecutionConfigured, optionExecutionSchemaReady
} from './option-execution-store.mjs';
import {
  createFormsCostPrivacyGate, formsCostPrivacySchemaReady
} from './forms-cost-privacy-store.mjs';

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
/** The owner must grant forms permissions in Cloudflare first (/connect/cloudflare?purpose=forms). */
export class FormsConsentRequired extends Error {
  constructor() { super('Cloudflare forms permission is required'); this.name = 'FormsConsentRequired'; }
}

export class OptionExecutionDisabled extends Error {
  constructor() {super('This optional feature has not been authorized for activation');}
}

/**
 * Production features stay disabled unless independently enabled by Domain #2.
 * Each D1 approved execution grant is a human/operator-approved, exact snapshot.
 * The customer session may request its execution, never mint the grant.
 * Forms additionally require OPTION_FORMS_ENABLED plus a live #89 cost/privacy gate.
 */
export async function executeOwnedStoredOption(env, current, executionId, {
  providerFactory = createCloudflareExtensionProvider, fetchFn
} = {}) {
  if (!isOptionExecutionConfigured(env) || !UUID.test(executionId || '') ||
      !await optionExecutionSchemaReady(env.DB) || !current)
    throw new OptionExecutionDisabled();
  const principal = {
    githubUserId: current.github_user_id,
    githubLogin: current.github_login,
    cloudflareAccountId: current.cloudflare_account_id
  };
  const stores = createD1OptionExecutionStore(env, current);
  // Read from D1; neither the caller nor form POST provides a trusted payload.
  const grant = await stores.approvalStore.readApproved({
    id: executionId, githubUserId: principal.githubUserId,
    cloudflareAccountId: principal.cloudflareAccountId
  });
  if (!grant) throw new OptionExecutionDisabled();
  if (grant.kind === 'forms') {
    if (env.OPTION_FORMS_ENABLED !== 'true' ||
        !await formsCostPrivacySchemaReady(env.DB))
      throw new OptionExecutionDisabled();
    // Incremental consent: forms scopes come only from the separate forms consent, never from sign-in.
    if (current.cloudflare_forms_grant !== 1) throw new FormsConsentRequired();
  } else if ((grant.kind === 'domain' && env.OPTION_DOMAIN_ENABLED !== 'true') ||
      (grant.kind === 'email' && env.OPTION_EMAIL_ENABLED !== 'true') ||
      (grant.kind === 'analytics' && env.OPTION_ANALYTICS_ENABLED !== 'true'))
    throw new OptionExecutionDisabled();
  const githubAccessToken = await getFreshAccessToken({env,session:current,provider:'github'});
  const cloudflareAccessToken = await getFreshAccessToken({env,session:current,provider:'cloudflare'});
  if (!await stores.assertCurrentAuthorization({owner:principal}))
    throw new OptionExecutionDisabled();
  const provider = providerFactory({
    principal, githubAccessToken, cloudflareAccessToken,
    ...(fetchFn ? {fetchFn} : {}),
    assertOperatorApprovedExecution: stores.assertOperatorApprovedExecution
  });
  try {
    return await consumeStoredToolkitApproval({
      approvalId: executionId, principal,
      approvalStore: stores.approvalStore,
      siteStore: stores.siteStore,
      provider, assertCurrentAuthorization: stores.assertCurrentAuthorization,
      ...(grant.kind === 'forms'
        ? {verifyFormsCostPrivacyGate: createFormsCostPrivacyGate(env, current),
          formsReceipts: stores.formsReceipts}
        : {})
    });
  } catch (error) {
    // Missing #89 gate or form provider adapters remain "not authorized", not a soft 400.
    if (grant.kind === 'forms' &&
        /^(cost_privacy_|forms_provider_|forms_consent_|forms_site_)/.test(error?.code || ''))
      throw new OptionExecutionDisabled();
    throw error;
  }
}
