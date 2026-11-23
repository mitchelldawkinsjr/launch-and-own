import test from 'node:test';
import assert from 'node:assert/strict';
import {
  accountId, approvePreview, connectTenant, csrfFrom, harness, jobRow, makeDue,
  newPreview, post
} from './worker-test-support.mjs';
import { createD1OptionExecutionStore } from './option-execution-store.mjs';

const host='www.example.com';
const id='22222222-2222-4222-8222-222222222222';
const otherId='33333333-3333-4333-8333-333333333333';

async function live(h,t){
  t.mock.method(globalThis,'fetch',h.fetchFn);
  const tenant=await connectTenant(h);
  const jobId=await newPreview(h,tenant);
  assert.equal((await approvePreview(h,tenant.cookie,tenant.csrf,jobId)).status,303);
  makeDue(h);
  assert.equal((await post(h,'/launch',tenant.cookie,{csrf:tenant.csrf,id:jobId})).status,303);
  makeDue(h);
  assert.equal((await post(h,'/verify',tenant.cookie,{csrf:tenant.csrf,id:jobId})).status,303);
  tenant.csrf=csrfFrom(await (await h.request('/',{cookie:tenant.cookie})).text());
  h.env.OPTION_EXECUTION_ENABLED='true';
  h.env.OPTION_DOMAIN_ENABLED='true';
  h.env.OPTION_EMAIL_ENABLED='true';
  return {tenant,jobId};
}
async function store(h,tenant,jobId,kind,values){
  const fields={csrf:tenant.csrf,id:jobId,kind,...values};
  const prepared=await post(h,'/site-options-prepare',tenant.cookie,fields);
  assert.equal(prepared.status,200);
  const html=await prepared.text();
  const digest=html.match(/name="digest" value="([a-f0-9]{64})"/)?.[1];
  assert.ok(digest);
  assert.equal((await post(h,'/site-options-approve',tenant.cookie,{
    ...fields,digest
  })).status,303);
  return h.sqlite.prepare('SELECT * FROM onboarding_option_approvals WHERE job_id = ? AND kind = ?')
    .get(jobId,kind);
}
function ownerSession(h){
  const s=h.sqlite.prepare('SELECT * FROM onboarding_sessions ORDER BY created_at LIMIT 1').get();
  return {...s,hash:s.id_hash};
}
function operatorGrant(h,option,uuid=id,overrides={}){
  const job=jobRow(h);
  const s=ownerSession(h);
  const p=JSON.parse(option.payload_json);
  const normalized=option.kind==='domain'?{hostname:p.plan.hostname}:
    option.kind==='email'?{hostname:p.plan.hostname,mailbox:p.plan.mailbox}:
      {hostname:'esp-'+job.site_slug+'-site.pages.dev',name:job.customer_name,ownerEmail:p.ownerEmail};
  const time=Math.floor(Date.now()/1000);
  const values={
    id:uuid,option_approval_id:option.id,job_id:job.id,
    github_user_id:job.github_user_id,cloudflare_account_id:accountId,
    kind:option.kind,approval_digest:option.approval_digest,payload_json:JSON.stringify(normalized),
    repository_id:job.repository_id,pages_project_id:job.pages_project_id,
    expected_commit_sha:job.expected_commit_sha,authorization_epoch:s.authorization_epoch,
    operator_grant_id:'domain-reviewed-'+uuid,approved_at:time,expires_at:time+600,
    status:'approved',updated_at:time,...overrides
  };
  const columns=Object.keys(values),sql='INSERT INTO onboarding_option_executions ('+
    columns.join(',')+') VALUES ('+columns.map(()=>'?').join(',')+')';
  h.sqlite.prepare(sql).run(...Object.values(values));
  return uuid;
}
const providerWrites=h=>h.calls.filter(call=>
  call.method!=='GET' && (/\/domains$|\/email\/routing\/rules$/.test(call.url)));

test('stored approval without separate operator grant cannot write or display activation',async t=>{
  const h=harness();t.after(()=>h.sqlite.close());
  const {tenant,jobId}=await live(h,t);
  await store(h,tenant,jobId,'domain',{hostname:host});
  const html=await (await h.request('/site-options?id='+jobId,{cookie:tenant.cookie})).text();
  assert.doesNotMatch(html,/Apply operator-approved domain/);
  const before=providerWrites(h).length;
  assert.equal((await post(h,'/site-options-execute',tenant.cookie,{
    csrf:tenant.csrf,id
  })).status,403);
  assert.equal(providerWrites(h).length,before);
});

test('feature release switch is fail-closed even when an approved execution row exists',async t=>{
  const h=harness();t.after(()=>h.sqlite.close());
  const {tenant,jobId}=await live(h,t);
  const row=await store(h,tenant,jobId,'domain',{hostname:host});
  operatorGrant(h,row);
  h.env.OPTION_EXECUTION_ENABLED='false';
  assert.equal((await post(h,'/site-options-execute',tenant.cookie,{csrf:tenant.csrf,id})).status,403);
  assert.equal(providerWrites(h).length,0);
});

test('operator-authorized domain attaches exactly one hostname and records CAS receipt',async t=>{
  const h=harness();t.after(()=>h.sqlite.close());
  const {tenant,jobId}=await live(h,t);
  const row=await store(h,tenant,jobId,'domain',{hostname:host});
  operatorGrant(h,row);
  const page=await (await h.request('/site-options?id='+jobId,{cookie:tenant.cookie})).text();
  assert.match(page,/Apply operator-approved domain/);
  const applied=await post(h,'/site-options-execute',tenant.cookie,{csrf:tenant.csrf,id});
  assert.equal(applied.status,200);
  assert.match(await applied.text(),/DNS and TLS may still need manual setup/);
  assert.equal(providerWrites(h).length,1);
  assert.equal(providerWrites(h)[0].url,
    'https://api.cloudflare.com/client/v4/accounts/'+accountId+
    '/pages/projects/esp-willow-studio-site/domains');
  const done=h.sqlite.prepare('SELECT * FROM onboarding_option_executions WHERE id = ?').get(id);
  assert.equal(done.status,'applied');
  assert.equal(JSON.parse(done.result_json).hostname,host);
  assert.equal(JSON.parse(done.result_json).dnsWritten,false);
  assert.equal(JSON.parse(done.result_json).mxWritten,false);
  assert.equal((await post(h,'/site-options-execute',tenant.cookie,{csrf:tenant.csrf,id})).status,403);
  assert.equal(providerWrites(h).length,1);
});

test('the operator grant is bound to digest, exact payload, target SHA, and session epoch',async t=>{
  const cases=[
    {approval_digest:'f'.repeat(64)},
    {payload_json:JSON.stringify({hostname:'attacker.example.com'})},
    {expected_commit_sha:'f'.repeat(40)},
    {authorization_epoch:777},
    {cloudflare_account_id:'c'.repeat(32)}
  ];
  for(const change of cases){
    const h=harness();t.after(()=>h.sqlite.close());
    const {tenant,jobId}=await live(h,t);
    const row=await store(h,tenant,jobId,'domain',{hostname:host});
    operatorGrant(h,row,id,change);
    assert.equal((await post(h,'/site-options-execute',tenant.cookie,{csrf:tenant.csrf,id})).status,403);
    assert.equal(providerWrites(h).length,0);
  }
});

test('another owner and stale replaced approval cannot activate a domain',async t=>{
  const h=harness();t.after(()=>h.sqlite.close());
  const {tenant,jobId}=await live(h,t);
  const row=await store(h,tenant,jobId,'domain',{hostname:host});
  operatorGrant(h,row);
  h.resourceState.githubUserId=99;
  const other=await connectTenant(h);
  assert.equal((await post(h,'/site-options-execute',other.cookie,{csrf:other.csrf,id})).status,403);
  assert.equal(providerWrites(h).length,0);
  // Restoring original user does not restore a replaced review digest or ID.
  h.resourceState.githubUserId=42;
  const rewritten=await store(h,tenant,jobId,'domain',{hostname:'other.example.com'});
  assert.notEqual(rewritten.id,row.id);
  assert.equal((await post(h,'/site-options-execute',tenant.cookie,{csrf:tenant.csrf,id})).status,403);
  assert.equal(providerWrites(h).length,0);
});

test('only one concurrent claimant can transition approved -> applying',async t=>{
  const h=harness();t.after(()=>h.sqlite.close());
  const {tenant,jobId}=await live(h,t);
  const row=await store(h,tenant,jobId,'domain',{hostname:host});
  operatorGrant(h,row);
  const s=ownerSession(h);
  const a=createD1OptionExecutionStore(h.env,s).approvalStore;
  const b=createD1OptionExecutionStore(h.env,s).approvalStore;
  const selector={id,githubUserId:s.github_user_id,cloudflareAccountId:accountId};
  const [ra,rb]=await Promise.all([a.readApproved(selector),b.readApproved(selector)]);
  assert.ok(ra);assert.ok(rb);
  const canonical=r=>({...r,jobId:r.job_id,githubUserId:r.github_user_id,
    cloudflareAccountId:r.cloudflare_account_id,digest:r.approval_digest,payloadJson:r.payload_json});
  const wins=await Promise.all([a.claimApproved(canonical(ra)),b.claimApproved(canonical(rb))]);
  assert.deepEqual(wins.sort(),[false,true]);
  assert.equal(h.sqlite.prepare('SELECT status FROM onboarding_option_executions WHERE id = ?')
    .get(id).status,'applying');
  assert.equal(providerWrites(h).length,0);
});

test('email cannot create a rule before matching domain execution is applied',async t=>{
  const h=harness();t.after(()=>h.sqlite.close());
  const {tenant,jobId}=await live(h,t);
  await store(h,tenant,jobId,'domain',{hostname:host});
  const row=await store(h,tenant,jobId,'email',{hostname:host,mailbox:'existing@example.net'});
  operatorGrant(h,row);
  const before=providerWrites(h).length;
  const response=await post(h,'/site-options-execute',tenant.cookie,{csrf:tenant.csrf,id});
  assert.notEqual(response.status,200);
  assert.equal(providerWrites(h).length,before);
});

test('forms cannot activate even with stored consent and an operator execution row (#89)',async t=>{
  const h=harness();t.after(()=>h.sqlite.close());
  const {tenant,jobId}=await live(h,t);
  const row=await store(h,tenant,jobId,'forms',{
    ownerEmail:'owner@example.net',formsConsent:'true'
  });
  operatorGrant(h,row);
  assert.equal((await post(h,'/site-options-execute',tenant.cookie,{csrf:tenant.csrf,id})).status,403);
  assert.equal(providerWrites(h).length,0);
});

test('missing CSRF and altered request data never trigger provider calls',async t=>{
  const h=harness();t.after(()=>h.sqlite.close());
  const {tenant,jobId}=await live(h,t);
  const row=await store(h,tenant,jobId,'domain',{hostname:host});
  operatorGrant(h,row);
  const bad=await post(h,'/site-options-execute',tenant.cookie,{csrf:'bad',id});
  assert.equal(bad.status,400);
  const extra=await post(h,'/site-options-execute',tenant.cookie,{
    csrf:tenant.csrf,id,hostname:'www.attacker.com'
  });
  assert.equal(extra.status,400);
  assert.equal(providerWrites(h).length,0);
});
