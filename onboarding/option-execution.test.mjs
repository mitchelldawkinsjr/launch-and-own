import {CUSTOMER_FORM_WORKER_SOURCE} from '../pipeline/customer-form-worker-source.mjs';
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

test('stored approval without owner or operator grant cannot execute',async t=>{
  const h=harness();t.after(()=>h.sqlite.close());
  const {tenant,jobId}=await live(h,t);
  await store(h,tenant,jobId,'domain',{hostname:host});
  h.env.OPTION_OWNER_ACTIVATION_ENABLED='false';
  const html=await (await h.request('/site-options?id='+jobId,{cookie:tenant.cookie})).text();
  assert.doesNotMatch(html,/Apply operator-approved domain/);
  assert.doesNotMatch(html,/Turn on custom domain/);
  const before=providerWrites(h).length;
  assert.equal((await post(h,'/site-options-execute',tenant.cookie,{
    csrf:tenant.csrf,id
  })).status,403);
  assert.equal(providerWrites(h).length,before);
});

test('owner self-activation turns on domain after a stored request',async t=>{
  const h=harness();t.after(()=>h.sqlite.close());
  const {tenant,jobId}=await live(h,t);
  const row=await store(h,tenant,jobId,'domain',{hostname:host});
  h.env.OPTION_OWNER_ACTIVATION_ENABLED='true';
  const page=await (await h.request('/site-options?id='+jobId,{cookie:tenant.cookie})).text();
  assert.match(page,/Turn on custom domain/);
  assert.doesNotMatch(page,/Apply operator-approved domain/);
  const applied=await post(h,'/site-options-activate',tenant.cookie,{
    csrf:tenant.csrf,approvalId:row.id
  });
  assert.equal(applied.status,200);
  assert.match(await applied.text(),/custom hostname is attached/);
  assert.equal(providerWrites(h).length,1);
  const done=h.sqlite.prepare('SELECT status,operator_grant_id FROM onboarding_option_executions '+
    'WHERE option_approval_id = ?').get(row.id);
  assert.equal(done.status,'applied');
  assert.match(done.operator_grant_id,/^owner-self:/);
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

test('approved forms execution sets up the widget, D1 and form Worker, and reapproval keeps the old receipt',async t=>{
  const h=harness();t.after(()=>h.sqlite.close());
  const fetchLaunch=h.fetchFn;
  const databaseId='11111111-2222-3333-4444-555555555555';
  const writes=[];
  let uploaded=null;
  h.fetchFn=async (url, init={})=>{
    const path=new URL(url).pathname;
    const ok=result=>Response.json({success:true,result,result_info:{page:1,total_pages:1,total_count:0}});
    if(path.endsWith('/rotate_secret')){writes.push({path,data:JSON.parse(init.body)});return ok({sitekey:'test-sitekey',secret:'rotated-test-secret-0001'});}
    if(path.endsWith('/workers/subdomain'))return ok({subdomain:'acct'});
    if(/\/workers\/scripts$/.test(path))return ok([]);
    if(/\/workers\/scripts\/[^/]+$/.test(path)&&init.method==='PUT'){
      uploaded=JSON.parse(await init.body.get('metadata').text());
      writes.push({path,module:await init.body.get('form.mjs').text()});
      return ok({id:path.split('/').pop()});
    }
    if(path.endsWith('/subdomain')){writes.push({path,data:JSON.parse(init.body)});return ok({enabled:true,previews_enabled:false});}
    if(path.endsWith('/schedules')){writes.push({path,data:JSON.parse(init.body)});return ok({schedules:[{cron:'17 3 * * *'}]});}
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
  // Incremental consent: forms setup needs the separate forms grant; a plain sign-in gets the consent page and no writes.
  const gated=await post(h,'/site-options-execute',tenant.cookie,{csrf:tenant.csrf,id});
  assert.equal(gated.status,403);
  assert.match(await gated.text(),/Allow form setup in Cloudflare/);
  assert.equal(writes.length,0);
  h.sqlite.prepare('UPDATE onboarding_sessions SET cloudflare_forms_grant=1').run();
  const staged=await post(h,'/site-options-execute',tenant.cookie,{csrf:tenant.csrf,id});
  const html=await staged.text();
  assert.equal(staged.status,200,html);
  assert.match(html,/Connect your contact form/);
  assert.doesNotMatch(html,/Email Routing alias|test-secret/);
  assert.equal(writes.length,7);
  const script='esp-willow-studio-site-form';
  assert.deepEqual(writes.slice(3).map(write=>write.path.split('/').slice(-2).join('/')),
    ['test-sitekey/rotate_secret','scripts/'+script,script+'/subdomain',script+'/schedules']);
  assert.equal(uploaded.bindings.find(binding=>binding.name==='TURNSTILE_SECRET').text,'rotated-test-secret-0001');
  assert.equal(uploaded.bindings.find(binding=>binding.type==='d1').database_id,databaseId);
  assert.equal(writes[4].module,CUSTOMER_FORM_WORKER_SOURCE);
  assert.deepEqual(writes[2],{path:'/client/v4/accounts/'+account+'/d1/database/'+databaseId+'/query',
    data:{sql:CUSTOMER_FORM_SCHEMA_SQL}});
  const execution=h.sqlite.prepare('SELECT status,result_json FROM onboarding_option_executions WHERE id=?').get(id);
  assert.equal(execution.status,'applied');
  const result=JSON.parse(execution.result_json);
  assert.equal(result.status,'form_worker_deployed');
  assert.equal(result.workerUrl,'https://'+script+'.acct.workers.dev');
  assert.equal(execution.result_json.includes('rotated-test-secret'),false,'the secret is never stored');
  assert.equal(result.workingForm,false);

  const replacement=await store(h,tenant,jobId,'forms',{...form,ownerEmail:'revised@example.net'});
  assert.notEqual(replacement.id,row.id);
  const receipts=h.sqlite.prepare('SELECT forms_option_approval_id,database_id,schema_applied FROM onboarding_forms_provisioning').all();
  assert.deepEqual(receipts.map(receipt=>({...receipt})),[
    {forms_option_approval_id:row.id,database_id:databaseId,schema_applied:1}
  ]);
  operatorGrant(h,replacement,otherId);
  assert.equal((await post(h,'/site-options-execute',tenant.cookie,{csrf:tenant.csrf,id:otherId})).status,403);
  assert.equal(writes.length,7,"a reapproval writes nothing new");
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

// Owner decision 2026-11-26: the owner can turn on the contact form after an explicit cost/privacy review,
// replacing the out-of-band operator row. Same Cloudflare mock as the operator-path test above.
function formsCloudflareMock(h,writes){
  const fetchLaunch=h.fetchFn;
  h.fetchFn=async (url, init={})=>{
    const path=new URL(url).pathname;
    const ok=result=>Response.json({success:true,result,result_info:{page:1,total_pages:1,total_count:0}});
    if(path.endsWith('/rotate_secret')){writes.push({path});return ok({sitekey:'test-sitekey',secret:'rotated-test-secret-0001'});}
    if(path.endsWith('/workers/subdomain'))return ok({subdomain:'acct'});
    if(/\/workers\/scripts$/.test(path))return ok([]);
    if(/\/workers\/scripts\/[^/]+$/.test(path)&&init.method==='PUT'){writes.push({path});return ok({id:path.split('/').pop()});}
    if(path.endsWith('/subdomain')){writes.push({path});return ok({enabled:true,previews_enabled:false});}
    if(path.endsWith('/schedules')){writes.push({path});return ok({schedules:[{cron:'17 3 * * *'}]});}
    if(/\/challenges\/widgets$|\/d1\/database(?:\/[^/]+\/query)?$/.test(path)){
      const data=init.body?JSON.parse(init.body):null;
      if(init.method==='POST')writes.push({path});
      const result=init.method!=='POST'?[]:path.endsWith('/widgets')?{...data,sitekey:'test-sitekey',secret:'test-secret'}:
        path.endsWith('/database')?{name:data.name,uuid:'11111111-2222-3333-4444-555555555555'}:[{success:true}];
      return ok(result);
    }
    return fetchLaunch(url,init);
  };
}
async function storedFormsForOwner(h,t){
  const writes=[];
  formsCloudflareMock(h,writes);
  Object.assign(h.env,{OPTION_EXECUTION_ENABLED:'true',OPTION_OWNER_ACTIVATION_ENABLED:'true',OPTION_FORMS_ENABLED:'true'});
  const {tenant,jobId}=await live(h,t);
  const row=await store(h,tenant,jobId,'forms',{ownerEmail:'owner@example.net',formsConsent:'true'});
  const choices={csrf:tenant.csrf,approvalId:row.id,retentionDays:'30',maxSubmissionsPerDay:'50',maxBodyBytes:'8192',costApproved:'true',privacyApproved:'true'};
  return {tenant,jobId,row,writes,choices};
}
const gateRows=h=>h.sqlite.prepare('SELECT operator_grant_id, retention_days, max_submissions_per_day FROM onboarding_forms_cost_privacy_approvals').all();

test('owner turns on the contact form after the cost/privacy review: gate row from the owner, then the real setup',async t=>{
  const h=harness();t.after(()=>h.sqlite.close());
  const {tenant,jobId,row,writes,choices}=await storedFormsForOwner(h,t);
  const options=await (await h.request('/site-options?id='+jobId,{cookie:tenant.cookie})).text();
  assert.match(options,/href="\/site-options-forms-turn-on\?approvalId=[^"]+">Turn on contact form</);
  // Without the Cloudflare forms permission: consent page, nothing written.
  assert.match(await (await h.request('/site-options-forms-turn-on?approvalId='+row.id,{cookie:tenant.cookie})).text(),/Allow form setup in Cloudflare/);
  const early=await post(h,'/site-options-activate',tenant.cookie,choices);
  assert.equal(early.status,403);
  assert.deepEqual(gateRows(h),[]);
  assert.equal(writes.length,0);
  h.sqlite.prepare('UPDATE onboarding_sessions SET cloudflare_forms_grant=1').run();
  const review=await (await h.request('/site-options-forms-turn-on?approvalId='+row.id,{cookie:tenant.cookie})).text();
  assert.match(review,/personal data/);
  assert.match(review,/name="costApproved" value="true" required/);
  assert.match(review,/name="privacyApproved" value="true" required/);
  const on=await post(h,'/site-options-activate',tenant.cookie,choices);
  const html=await on.text();
  assert.equal(on.status,200,html);
  assert.match(html,/Connect your contact form/);
  assert.deepEqual(gateRows(h).map(r=>({...r})),[{operator_grant_id:'owner-self-cost-privacy:'+row.id,retention_days:30,max_submissions_per_day:50}]);
  assert.equal(writes.length,7,'widget, D1, schema, secret rotation, Worker, subdomain, schedule');
});

test('owner forms turn-on refuses missing confirmations or out-of-range limits with no provider writes',async t=>{
  const h=harness();t.after(()=>h.sqlite.close());
  const {tenant,writes,choices}=await storedFormsForOwner(h,t);
  h.sqlite.prepare('UPDATE onboarding_sessions SET cloudflare_forms_grant=1').run();
  for(const [field,value,code] of [['privacyApproved','false','privacy_owner_approval_required'],['costApproved','false','cost_owner_approval_required'],
    ['retentionDays','999','retention_days_out_of_range'],['maxSubmissionsPerDay','0','max_submissions_per_day_out_of_range']]){
    const res=await post(h,'/site-options-activate',tenant.cookie,{...choices,[field]:value});
    assert.equal(res.status,400,field);
    assert.match(await res.text(),new RegExp(code));
  }
  assert.deepEqual(gateRows(h),[]);
  assert.equal(writes.length,0);
});

test('an operator-approved forms gate row is never overwritten by the owner path',async t=>{
  const h=harness();t.after(()=>h.sqlite.close());
  const {tenant,jobId,row,writes,choices}=await storedFormsForOwner(h,t);
  const job=jobRow(h),time=Math.floor(Date.now()/1000);
  h.sqlite.prepare(`INSERT INTO onboarding_forms_cost_privacy_approvals(id,forms_option_approval_id,job_id,github_user_id,cloudflare_account_id,
    pages_project_id,forms_digest,approval_digest,payload_json,retention_days,max_submissions_per_day,max_body_bytes,operator_grant_id,
    approved_at,expires_at,status,updated_at) VALUES ('f2345678-1234-4234-8234-123456789abc',?,?,?,?,?,?,?,'{}',90,10,4096,'operator-x',?,?,'approved',?)`)
    .run(row.id,jobId,job.github_user_id,job.cloudflare_account_id,job.pages_project_id,row.approval_digest,'a'.repeat(64),time,time+600,time);
  h.sqlite.prepare('UPDATE onboarding_sessions SET cloudflare_forms_grant=1').run();
  const res=await post(h,'/site-options-activate',tenant.cookie,choices);
  assert.equal(res.status,400);
  assert.match(await res.text(),/cost_privacy_row_conflict/);
  assert.deepEqual(gateRows(h).map(r=>({...r})),[{operator_grant_id:'operator-x',retention_days:90,max_submissions_per_day:10}]);
  assert.equal(writes.length,0);
});

// Owner turn-on for visitor insights (owner decision 2026-11-26): two exact writes in the owner's account.
function analyticsCloudflareMock(h,state){
  const fetchLaunch=h.fetchFn;
  h.fetchFn=async (url, init={})=>{
    const u=new URL(url),path=u.pathname,method=init.method||'GET';
    const ok=result=>Response.json({success:true,result,result_info:{page:1,total_pages:1,total_count:0}});
    if(path.endsWith('/rum/site_info/list'))return ok(state.existing?[{host:state.host,site_tag:'a'.repeat(32),site_token:'b'.repeat(32)}]:[]);
    if(path.endsWith('/rum/site_info')&&method==='POST'){state.writes.push({method,path,body:JSON.parse(init.body)});return ok({host:JSON.parse(init.body).host,site_tag:'c'.repeat(32),site_token:'d'.repeat(32)});}
    if(/\/pages\/projects\/[^/]+$/.test(path)&&method==='PATCH'){state.writes.push({method,path,body:JSON.parse(init.body)});return ok({name:path.split('/').pop(),build_config:JSON.parse(init.body).build_config});}
    if(/\/pages\/projects\/[^/]+$/.test(path)&&method==='GET'&&state.buildConfig){
      const real=await (await fetchLaunch(url,init)).json();
      return Response.json({...real,result:{...real.result,build_config:state.buildConfig}});
    }
    return fetchLaunch(url,init);
  };
}
async function storedAnalyticsForOwner(h,t,state){
  Object.assign(h.env,{OPTION_EXECUTION_ENABLED:'true',OPTION_OWNER_ACTIVATION_ENABLED:'true',OPTION_ANALYTICS_ENABLED:'true'});
  const {tenant,jobId}=await live(h,t);
  const row=await store(h,tenant,jobId,'analytics',{analyticsConsent:'true'});
  analyticsCloudflareMock(h,state); // only the turn-on sees the mocked analytics and project responses
  globalThis.fetch=h.fetchFn;
  state.host=jobRow(h).site_slug?'esp-'+jobRow(h).site_slug+'-site.pages.dev':null;
  return {tenant,jobId,row};
}

test('owner turns on visitor insights: creates the Web Analytics site and sets it on the managed Pages project only',async t=>{
  const h=harness();t.after(()=>h.sqlite.close());
  const state={writes:[],buildConfig:{build_command:'',destination_dir:'public',root_dir:'/'}};
  const {tenant,jobId,row}=await storedAnalyticsForOwner(h,t,state);
  const options=await (await h.request('/site-options?id='+jobId,{cookie:tenant.cookie})).text();
  assert.match(options,/Turn on visitor insights/);
  const on=await post(h,'/site-options-activate',tenant.cookie,{csrf:tenant.csrf,approvalId:row.id});
  const html=await on.text();
  assert.equal(on.status,200,html);
  assert.match(html,/Visitor insights are turned on/);
  assert.match(html,/next time your site is published/);
  assert.deepEqual(state.writes.map(w=>w.method+' '+w.path.split('/').slice(-2).join('/')),['POST rum/site_info','PATCH projects/'+state.host.replace('.pages.dev','')]);
  assert.deepEqual(state.writes[0].body,{host:state.host,auto_install:false});
  assert.deepEqual(state.writes[1].body,{build_config:{build_command:'',destination_dir:'public',root_dir:'/',web_analytics_tag:'c'.repeat(32),web_analytics_token:'d'.repeat(32)}});
});

test('visitor insights reuse an existing analytics site and leave hand-changed build settings alone',async t=>{
  const h=harness();t.after(()=>h.sqlite.close());
  const state={writes:[],existing:true,buildConfig:{build_command:'',destination_dir:'public',root_dir:'/'}};
  const {tenant,row}=await storedAnalyticsForOwner(h,t,state);
  assert.equal((await post(h,'/site-options-activate',tenant.cookie,{csrf:tenant.csrf,approvalId:row.id})).status,200);
  assert.deepEqual(state.writes.map(w=>w.method),['PATCH'],'no second analytics site');
  assert.equal(state.writes[0].body.build_config.web_analytics_tag,'a'.repeat(32));

  const h2=harness();t.after(()=>h2.sqlite.close());
  const changed={writes:[],buildConfig:{build_command:'npm run build',destination_dir:'dist',root_dir:'/'}};
  const second=await storedAnalyticsForOwner(h2,t,changed);
  const res=await post(h2,'/site-options-activate',second.tenant.cookie,{csrf:second.tenant.csrf,approvalId:second.row.id});
  assert.notEqual(res.status,200);
  assert.doesNotMatch(await res.text(),/Visitor insights are turned on/);
  assert.deepEqual(changed.writes,[],'a hand-changed project is refused before any write, and never patched');
});
