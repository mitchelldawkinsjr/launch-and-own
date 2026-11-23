import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {buildTurnstileFormReviewPlan, projectContactFormsCapability, TURNSTILE_FREE_LIMITS}
  from './turnstile-form-review.mjs';
import {planCustomer} from './plan-customer.mjs';

const now = 1795345200;
const owner = {siteId:'managed_123_page', githubUserId:7, repositoryId:123,
  pagesProjectId:'page', cloudflareAccountId:'a'.repeat(32), baseCommitSha:'b'.repeat(40),
  productionBranch:'main'};
const hostname = 'willow.example';
const deliveryTarget = 'owner-email-forward';
const evidence = {siteId:owner.siteId, githubUserId:owner.githubUserId, repositoryId:owner.repositoryId,
  pagesProjectId:owner.pagesProjectId, cloudflareAccountId:owner.cloudflareAccountId,
  baseCommitSha:owner.baseCommitSha, checkedAt:now-10, expiresAt:now+200};
const hostnameEvidence = {...evidence, kind:'verified-production-hostname', hostname};
const deliveryEvidence = {...evidence, kind:'verified-contact-destination', deliveryTarget,
  destinationId:'delivery_exampleowner', expiresAt:now+100};
const input = {owner, consent:true, hostname, hostnameEvidence, deliveryTarget, deliveryEvidence,
  expectedAction:'contact', rateLimitPerHour:20, retentionDays:14, deletionPlan:'time-bound'};
const review = (changes={}, clock=now) => buildTurnstileFormReviewPlan({...input,...changes}, {now:clock});

test('form review binds the exact verified scope, requires Siteverify and grants no action',()=>{
  const result = review();
  assert.equal(result.status,'review_only');
  assert.equal(result.state,'manual_setup');
  assert.equal(result.canActivate,false);
  assert.equal(result.canWrite,false);
  assert.equal(result.workingForm,false);
  assert.equal(result.requiresSeparateHumanApproval,true);
  assert.equal(result.plan.hostname,hostname);
  assert.equal(result.plan.expiresAt,deliveryEvidence.expiresAt);
  assert.equal(result.plan.delivery.destinationId,deliveryEvidence.destinationId);
  assert.equal(result.plan.expectedAction,'contact');
  assert.equal(result.plan.siteverify.requireSuccess,true);
  assert.equal(result.plan.siteverify.requireMatchingAction,true);
  assert.equal(result.plan.siteverify.requireMatchingHostname,true);
  assert.equal(result.plan.siteverify.singleUse,true);
  assert.equal(result.plan.siteverify.tokenTtlSeconds,300);
  assert.equal(TURNSTILE_FREE_LIMITS.widgetsPerAccount,20);
  assert.equal(createHash('sha256').update(JSON.stringify(result.plan)).digest('hex'),result.approvalDigest);
});

test('missing, stale or wrong tenant, site or base evidence cannot make a form plan',()=>{
  for (const changes of [
    {hostnameEvidence:null}, {deliveryEvidence:null},
    {hostnameEvidence:{...hostnameEvidence, expiresAt:now}},
    {hostnameEvidence:{...hostnameEvidence, cloudflareAccountId:'c'.repeat(32)}},
    {hostnameEvidence:{...hostnameEvidence, checkedAt:now+1}},
    {deliveryEvidence:{...deliveryEvidence, repositoryId:8}},
    {deliveryEvidence:{...deliveryEvidence, baseCommitSha:'c'.repeat(40)}},
    {deliveryEvidence:{...deliveryEvidence, expiresAt:now+1000}},
    {hostname:'other.example'}, {consent:false}
  ]) assert.equal(review(changes).approvalDigest,null);
  assert.equal(review({},Infinity).approvalDigest,null);
});

test('ambiguous hosts and raw destination details are refused or omitted',()=>{
  for (const host of ['https://willow.example','a..example','a.-x.example','0.0.0.0','*.willow.example']) {
    assert.equal(review({hostname:host,hostnameEvidence:{...hostnameEvidence,hostname:host}}).approvalDigest,null);
  }
  assert.equal(review({deliveryEvidence:{...deliveryEvidence,destinationId:'owner@willow.example'}}).approvalDigest,null);
  const result = review({deliveryEvidence:{...deliveryEvidence, address:'owner@willow.example',secret:'sample-value'}});
  assert.doesNotMatch(JSON.stringify(result),/owner@willow|sample-value/);
});

test('retention and quotas are explicit, and the D1 option awaits its own review',()=>{
  assert.equal(review({deliveryTarget:'customer-owned-d1'}).reason,'separate_cost_and_privacy_review_required');
  for (const changes of [{deletionPlan:'owner-delete'},{retentionDays:0},{rateLimitPerHour:0},{expectedAction:''}])
    assert.equal(review(changes).approvalDigest,null);
});

test('the review digest changes with the delivery reference, expiry, rate or retention',()=>{
  const expected = review().approvalDigest;
  for (const changes of [
    {deliveryEvidence:{...deliveryEvidence,destinationId:'delivery_newtarget'}},
    {deliveryEvidence:{...deliveryEvidence,expiresAt:now+99}},
    {rateLimitPerHour:40},{retentionDays:21},{expectedAction:'contact_enquiry'}
  ]) assert.notEqual(review(changes).approvalDigest,expected);
});

test('only review and blocked capability states are projected',()=>{
  assert.equal(projectContactFormsCapability(review()).state,'manual_setup');
  assert.equal(projectContactFormsCapability(review({consent:false})).state,'blocked_permission_or_plan');
  for (const state of ['active_verified','included_verified'])
    assert.equal(projectContactFormsCapability({state}).state,'not_available');
});

test('the standalone form contract preserves the website-only launch plan',()=>{
  const plan = planCustomer({name:'Willow Studio', accountId:owner.cloudflareAccountId, githubOwner:'tester'});
  assert.equal(plan.forms,false);
  assert.deepEqual(plan.steps.map(step=>step.id),['github','pages','deploy']);
  assert.equal(Object.hasOwn(plan,'formsReview'),false);
});
