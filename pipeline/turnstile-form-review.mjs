// Issue #88: thin adapter over plan-customer forms planning.
// Source of truth for form/Turnstile steps + Siteverify gates is planCustomer().
import { TOOLKIT_CAPABILITY_STATES } from './toolkit-capabilities.mjs';
import {
  TURNSTILE_FREE_LIMITS,
  planCustomer
} from './plan-customer.mjs';

export { TURNSTILE_FREE_LIMITS };

const NEVER_ACTIVATE = Object.freeze({
  createResources: false,
  canActivate: false,
  canWrite: false,
  workingForm: false,
  widgetAloneInsufficient: true
});

function deny(state, reason, extras = {}) {
  if (!TOOLKIT_CAPABILITY_STATES.includes(state)) throw Error('unknown capability state');
  return Object.freeze({ state, reason, ...NEVER_ACTIVATE, ...extras });
}

/**
 * Build the formsReview slice from the shared planCustomer() forms path.
 * Accepts either planCustomer input, or a trusted owner snapshot mapped into it.
 */
export function buildTurnstileFormReviewPlan(input = {}) {
  try {
    const mapped = input.owner ? {
      name: input.name || input.owner.repositoryName || input.owner.siteId || 'managed-site',
      accountId: input.owner.cloudflareAccountId,
      githubOwner: input.owner.githubLogin,
      forms: true,
      formsConsent: input.consent === true,
      ownerEmail: input.ownerEmail,
      hostname: input.hostname
    } : {
      ...input,
      forms: true,
      formsConsent: input.formsConsent === true || input.consent === true
    };
    const plan = planCustomer(mapped);
    if (!plan.formsReview)
      return deny('not_available', 'forms_review_missing', { status: 'blocked', approvalDigest: null });
    if (plan.formsReview.status === 'blocked')
      return deny(plan.formsReview.reason === 'owner_form_consent_required'
        ? 'available_opt_in' : 'blocked_permission_or_plan', plan.formsReview.reason, {
        status: 'blocked',
        approvalDigest: null,
        freeLimits: TURNSTILE_FREE_LIMITS,
        provisioningSteps: Object.freeze(plan.steps.filter(step =>
          ['d1', 'turnstile', 'worker', 'access', 'form-deploy', 'acceptance'].includes(step.id)))
      });
    return Object.freeze({
      status: 'review_only',
      state: 'available_opt_in',
      reason: 'awaiting_owner_digest_approval_and_server_siteverify',
      approvalDigest: plan.formsReview.approvalDigest,
      plan: plan.formsReview,
      provisioningSteps: Object.freeze(plan.steps.filter(step =>
        ['d1', 'turnstile', 'worker', 'access', 'form-deploy', 'acceptance'].includes(step.id))),
      customerPlan: Object.freeze({
        mode: plan.mode,
        customer: plan.customer,
        domain: plan.domain,
        forms: plan.forms
      }),
      freeLimits: TURNSTILE_FREE_LIMITS,
      ...NEVER_ACTIVATE
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'invalid_forms_plan';
    if (/ownerEmail/.test(message))
      return deny('blocked_permission_or_plan', 'owner_email_required_for_forms', {
        status: 'blocked', approvalDigest: null, freeLimits: TURNSTILE_FREE_LIMITS
      });
    if (/hostname|Invalid hostname/i.test(message))
      return deny('blocked_permission_or_plan', 'authorized_hostname_required', {
        status: 'blocked', approvalDigest: null, freeLimits: TURNSTILE_FREE_LIMITS
      });
    if (/account ID|GitHub owner|Customer name|configuration/i.test(message))
      return deny('not_available', 'verified_owner_site_required', {
        status: 'blocked', approvalDigest: null, freeLimits: TURNSTILE_FREE_LIMITS
      });
    return deny('not_available', 'forms_plan_rejected', {
      status: 'blocked', approvalDigest: null, freeLimits: TURNSTILE_FREE_LIMITS
    });
  }
}

/** Toolkit contact_forms card projection. Never claims an enabled form. */
export function projectContactFormsCapability(reviewOrPlan) {
  const review = reviewOrPlan?.formsReview || reviewOrPlan;
  if (!review || typeof review !== 'object')
    return deny('not_available', 'form_review_required', { feature: 'contact_forms' });
  if (review.status === 'review_only' || review.kind === 'launch-and-own-forms-review')
    return Object.freeze({
      feature: 'contact_forms',
      state: 'available_opt_in',
      reason: 'server_siteverify_and_delivery_approval_required',
      ...NEVER_ACTIVATE
    });
  if (TOOLKIT_CAPABILITY_STATES.includes(review.state))
    return Object.freeze({
      feature: 'contact_forms',
      state: review.state,
      reason: review.reason,
      ...NEVER_ACTIVATE
    });
  return deny('not_available', 'unrecognized_form_review', { feature: 'contact_forms' });
}
