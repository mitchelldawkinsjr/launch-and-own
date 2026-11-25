import test from 'node:test';
import assert from 'node:assert/strict';
import {
  accountId, approvePreview, connectTenant, csrfFrom, harness, jobRow, makeDue,
  newPreview, post
} from './worker-test-support.mjs';
import { createD1OptionExecutionStore } from './option-execution-store.mjs';
import { buildFormsCostPrivacyReview, materializeApprovedFormsCostPrivacyRow } from '../pipeline/forms-cost-privacy-approval.mjs';
import { CUSTOMER_FORM_SCHEMA_SQL } from '../pipeline/forms-provider-plan.mjs';

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

test('replaced consent after the execution lease is claimed revokes provider mutation',async t=>{
  const h=harness();t.after(()=>h.sqlite.close());
  const {tenant,jobId}=await live(h,t);
  const row=await store(h,tenant,jobId,'domain',{hostname:host});
  operatorGrant(h,row);
  h.resourceState.replaceOptionWhileReadingDomain=true;
  assert.equal((await post(h,'/site-options-execute',tenant.cookie,{csrf:tenant.csrf,id})).status,400);
  assert.equal(providerWrites(h).length,0);
  assert.equal(h.sqlite.prepare('SELECT status FROM onboarding_option_executions WHERE id = ?')
    .get(id).status,'needs_reconciliation');
});

test('a changed live GitHub main SHA denies execution before any provider write or claim',async t=>{
  const h=harness();t.after(()=>h.sqlite.close());
  const {tenant,jobId}=await live(h,t);
  const row=await store(h,tenant,jobId,'domain',{hostname:host});
  operatorGrant(h,row);
  h.resourceState.headSha='f'.repeat(40);
  assert.equal((await post(h,'/site-options-execute',tenant.cookie,{csrf:tenant.csrf,id})).status,400);
  assert.equal(providerWrites(h).length,0);
  assert.equal(h.sqlite.prepare('SELECT status FROM onboarding_option_executions WHERE id = ?')
    .get(id).status,'approved');
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

test('applied domain and separate verified mailbox grant create exactly one contact forwarding rule',async t=>{
  const h=harness();t.after(()=>h.sqlite.close());
  const {tenant,jobId}=await live(h,t);
  const domain=await store(h,tenant,jobId,'domain',{hostname:host});
  operatorGrant(h,domain);
  const attached=await post(h,'/site-options-execute',tenant.cookie,{csrf:tenant.csrf,id});
  assert.equal(attached.status,200);
  assert.equal(h.sqlite.prepare('SELECT status FROM onboarding_option_executions WHERE id=?')
    .get(id).status,'applied');
  h.resourceState.customDomain.status='active'; // DNS/TLS activation is external/manual, never mutated by app.
  const email=await store(h,tenant,jobId,'email',{
    hostname:host,mailbox:'existing@example.net'
  });
  operatorGrant(h,email,otherId);
  const routed=await post(h,'/site-options-execute',tenant.cookie,{csrf:tenant.csrf,id:otherId});
  assert.equal(routed.status,200);
  assert.match(await routed.text(),/Email Routing alias was recorded/);
  assert.equal(h.sqlite.prepare('SELECT status FROM onboarding_option_executions WHERE id=?')
    .get(otherId).status,'applied');
  const ruleWrites=h.calls.filter(c=>c.method==='POST'&&/\/zones\/[a-f0-9]{32}\/email\/routing\/rules$/.test(c.url));
  assert.equal(ruleWrites.length,1);
  assert.equal(h.resourceState.emailRules.length,1);
  const rule=h.resourceState.emailRules[0];
  assert.deepEqual(rule.matchers,[{type:'literal',field:'to',value:'contact@'+host}]);
  assert.deepEqual(rule.actions,[{type:'forward',value:['existing@example.net']}]);
  assert.equal(h.calls.some(c=>c.method!=='GET'&&/\/dns_records|\/mx(?:\/|$)/i.test(c.url)),false);
  assert.equal(providerWrites(h).length,2);
});

test('ready parent zone cannot create subdomain forwarding without exact-host MX records',async t=>{
  const h=harness();t.after(()=>h.sqlite.close());
  const {tenant,jobId}=await live(h,t);
  const domain=await store(h,tenant,jobId,'domain',{hostname:host});
  operatorGrant(h,domain);
  assert.equal((await post(h,'/site-options-execute',tenant.cookie,{
    csrf:tenant.csrf,id
  })).status,200);
  h.resourceState.customDomain.status='active';
  h.resourceState.routingMxRecords=[]; // Existing apex setting can still say ready.
  const email=await store(h,tenant,jobId,'email',{
    hostname:host,mailbox:'existing@example.net'
  });
  operatorGrant(h,email,otherId);
  const outcome=await post(h,'/site-options-execute',tenant.cookie,{
    csrf:tenant.csrf,id:otherId
  });
  assert.notEqual(outcome.status,200);
  assert.equal(h.calls.some(c=>c.method==='POST'&&
    /\/email\/routing\/rules$/.test(c.url)),false);
  assert.equal(h.sqlite.prepare(
    'SELECT status FROM onboarding_option_executions WHERE id=?'
  ).get(otherId).status,'needs_reconciliation');
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
  h.env.OPTION_FORMS_ENABLED='true';
  assert.equal((await post(h,'/site-options-execute',tenant.cookie,{csrf:tenant.csrf,id})).status,403);
  assert.equal(providerWrites(h).length,0);
});

test('approved forms execution stages only the widget and D1, and reapproval keeps the old receipt',async t=>{
  const h=harness();t.after(()=>h.sqlite.close());
  const fetchLaunch=h.fetchFn;
  const databaseId='11111111-2222-3333-4444-555555555555';
  const writes=[];
  h.fetchFn=async (url, init={})=>{
    const path=new URL(url).pathname;
    if(/\/challenges\/widgets$|\/d1\/database(?:\/[^/]+\/query)?$/.test(path)){
      const data=init.body?JSON.parse(init.body):null;
      if(init.method==='POST')writes.push({path,data});
      const result=init.method!=='POST'?[]:
        path.endsWith('/widgets')?{...data,sitekey:'test-sitekey',secret:'test-secret'}:
        path.endsWith('/database')?{name:data.name,uuid:databaseId}:[{success:true}];
      return Response.json({success:true,result,result_info:{page:1,total_pages:1,total_count:0}});
    }
    return fetchLaunch(url,init);
  };
  const {tenant,jobId}=await live(h,t);
  const form={ownerEmail:'owner@example.net',formsConsent:'true'};
  const row=await store(h,tenant,jobId,'forms',form);
  const job=jobRow(h);
  const account=job.cloudflare_account_id;
  const limits={retentionDays:30,maxSubmissionsPerDay:50,maxBodyBytes:4096};
  const review=buildFormsCostPrivacyReview({jobId,githubUserId:job.github_user_id,cloudflareAccountId:account,
    pagesProjectId:job.pages_project_id,formsDigest:row.approval_digest,costApproved:true,privacyApproved:true,...limits});
  const approved=materializeApprovedFormsCostPrivacyRow(review,{approvalId:'f2345678-1234-4234-8234-123456789abc'});
  const time=Math.floor(Date.now()/1000);
  h.sqlite.prepare(`INSERT INTO onboarding_forms_cost_privacy_approvals(id,forms_option_approval_id,job_id,
    github_user_id,cloudflare_account_id,pages_project_id,forms_digest,approval_digest,payload_json,
    retention_days,max_submissions_per_day,max_body_bytes,operator_grant_id,approved_at,expires_at,status,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'approved',?)`).run(approved.id,row.id,jobId,job.github_user_id,account,
      job.pages_project_id,row.approval_digest,approved.approval_digest,approved.payload_json,
      limits.retentionDays,limits.maxSubmissionsPerDay,limits.maxBodyBytes,'forms-cost-test',time,time+600,time);
  operatorGrant(h,row);
  h.env.OPTION_FORMS_ENABLED='true';
  const staged=await post(h,'/site-options-execute',tenant.cookie,{csrf:tenant.csrf,id});
  const html=await staged.text();
  assert.equal(staged.status,200,html);
  assert.match(html,/ready for Worker review/);
  assert.doesNotMatch(html,/Email Routing alias|test-secret/);
  assert.equal(writes.length,3);
  assert.deepEqual(writes[2],{path:'/client/v4/accounts/'+account+'/d1/database/'+databaseId+'/query',
    data:{sql:CUSTOMER_FORM_SCHEMA_SQL}});
  const execution=h.sqlite.prepare('SELECT status,result_json FROM onboarding_option_executions WHERE id=?').get(id);
  assert.equal(execution.status,'applied');
  const result=JSON.parse(execution.result_json);
  assert.equal(result.status,'form_resources_staged');
  assert.equal(result.workerReview.readyForProviderWrite,false);
  assert.equal(result.workingForm,false);

  const replacement=await store(h,tenant,jobId,'forms',{...form,ownerEmail:'revised@example.net'});
  assert.notEqual(replacement.id,row.id);
  const receipts=h.sqlite.prepare('SELECT forms_option_approval_id,database_id,schema_applied FROM onboarding_forms_provisioning').all();
  assert.deepEqual(receipts.map(receipt=>({...receipt})),[
    {forms_option_approval_id:row.id,database_id:databaseId,schema_applied:1}
  ]);
  operatorGrant(h,replacement,otherId);
  assert.equal((await post(h,'/site-options-execute',tenant.cookie,{csrf:tenant.csrf,id:otherId})).status,403);
  assert.equal(writes.length,3);
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
