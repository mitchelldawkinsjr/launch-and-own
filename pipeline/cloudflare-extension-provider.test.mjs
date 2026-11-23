import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCloudflareExtensionProvider, ExtensionProviderError
} from './cloudflare-extension-provider.mjs';

const account = 'a'.repeat(32);
const zoneId = 'b'.repeat(32);
const owner = () => ({
  githubUserId: 42, githubLogin: 'siteowner', cloudflareAccountId: account
});
const site = () => ({
  githubUserId: 42, githubLogin: 'siteowner', cloudflareAccountId: account,
  pagesProjectName: 'esp-fern-site', repositoryName: 'esp-fern',
  productionBranch: 'main'
});
function page(result) {
  return {success: true, errors: [], messages: [], result,
    result_info: {page: 1, total_pages: 1}};
}
function rig({writes = false, override = {}} = {}) {
  const calls = [];
  const fetchFn = async (url, options) => {
    const path = new URL(url).pathname;
    const parsed = new URL(url);
    const call = {path, method: options.method, search: parsed.search,
      body: options.body ? JSON.parse(options.body) : undefined};
    calls.push(call);
    if (override[path]) return override[path](call);
    if (path.endsWith('/pages/projects/esp-fern-site'))
      return Response.json(page({id: 'p1', name: 'esp-fern-site'}));
    if (path.endsWith('/repos/siteowner/esp-fern'))
      return Response.json({id: 77, private: true, owner: {id: 42}});
    if (path.endsWith('/repos/siteowner/esp-fern/branches/main'))
      return Response.json({commit:{sha:'a'.repeat(40)}});
    if (path.endsWith('/pages/projects/esp-fern-site/domains/www.example.com'))
      return Response.json(page({name: 'www.example.com', status: 'active'}));
    if (path.endsWith('/pages/projects/esp-fern-site/domains'))
      return Response.json(page({name: call.body?.name, status: 'pending'}));
    if (path === '/client/v4/zones')
      return Response.json(page([{id:zoneId,name:'example.com',status:'active',account:{id:account}}]));
    if (path.endsWith('/zones/'+zoneId+'/email/routing'))
      return Response.json(page({enabled:true,status:'ready'}));
    if (path.endsWith('/email/routing/addresses'))
      return Response.json(page([{email:'existing@example.net', verified:'2026-11-22T00:00:00Z'}]));
    if (path.endsWith('/accounts/'+zoneId+'/email/routing/rules'))
      return Response.json(page([]));
    if (path.endsWith('/zones/'+zoneId+'/email/routing/rules'))
      return Response.json(page({id:'route1',enabled:true}));
    throw Error('unexpected URL ' + url);
  };
  const provider = createCloudflareExtensionProvider({
    principal: owner(), cloudflareAccessToken: 'cf-secret-token',
    githubAccessToken: 'gh-secret-token', fetchFn,
    ...(writes ? {assertOperatorApprovedExecution: async () => true} : {})
  });
  return {calls, provider};
}
function fail(promise, code) {
  return assert.rejects(promise, error =>
    error instanceof ExtensionProviderError && error.code === code &&
    !error.message.includes('secret-token'));
}

test('provider exposes no DNS/MX/billing/Turnstile/D1/Worker mutate endpoints', () => {
  const {provider} = rig();
  for(const key of ['createDnsRecord','changeMx','changeNameservers','deployServerVerifiedFormWorker',
    'createCustomerD1','createTurnstileWidget','purchaseDomain','activateBilling'])
    assert.equal(provider[key], undefined);
});

test('reads the exact owner repo and Pages project through bounded backend URLs', async () => {
  const {provider,calls} = rig();
  assert.equal((await provider.readPagesProject(site())).name, 'esp-fern-site');
  assert.equal((await provider.readGithubRepository(site())).id, 77);
  assert.equal((await provider.readGithubBranchHead(site())).commit.sha,'a'.repeat(40));
  assert.equal((await provider.readPagesDomain(site(),'www.example.com')).status, 'active');
  assert.deepEqual(calls.map(c=>c.method),['GET','GET','GET','GET']);
  assert.equal(calls.some(c=>/secret-token/.test(JSON.stringify(c))), false);
});

test('writes are OFF by default even if provider credential is present', async () => {
  const {provider,calls} = rig();
  await fail(provider.attachPagesDomain(site(), {name:'www.example.com'}),
    'separate_execution_approval_required');
  assert.equal(calls.length, 0);
});

test('named owner-approved writes only attach approved Pages domain or create Email Routing rule', async () => {
  const {provider,calls} = rig({writes:true});
  assert.equal((await provider.attachPagesDomain(site(), {name:'www.example.com'})).name,'www.example.com');
  const zone=await provider.readOwnedZone(site(), 'www.example.com');
  assert.equal(zone.id,zoneId);
  const settings=await provider.readEmailRoutingSettings(zoneId);
  assert.equal(settings.status,'ready');
  const destination=await provider.readVerifiedDestination(account,'existing@example.net');
  assert.ok(destination.verified);
  assert.equal(await provider.readEmailRoutingRule(zoneId,'contact@www.example.com'),null);
  const rule = await provider.createEmailRoutingRule(zoneId,{
    name:'Contact',source:'api',enabled:true,
    matchers:[{type:'literal',field:'to',value:'contact@www.example.com'}],
    actions:[{type:'forward',value:['existing@example.net']}]
  });
  assert.equal(rule.id,'route1');
  const writes = calls.filter(c=>c.method!=='GET');
  assert.equal(writes.length,2);
  assert.equal(writes[0].path,
    '/client/v4/accounts/'+account+'/pages/projects/esp-fern-site/domains');
  assert.equal(writes[1].path,
    '/client/v4/zones/'+zoneId+'/email/routing/rules');
  assert.equal(calls.some(c=>/\/dns(?:\/|$)|\/billing\b/.test(c.path)),false);
});

test('wrong account/tenant resource names and suspicious hostnames are denied before requests', async () => {
  const {provider,calls} = rig({writes:true});
  await fail(provider.readPagesProject({...site(), cloudflareAccountId:'c'.repeat(32)}),
    'owned_project_required');
  await fail(provider.readPagesDomain(site(),'attacker.pages.dev'), 'valid_hostname_required');
  await fail(provider.attachPagesDomain(site(),{name:'not..a.host'}),'valid_hostname_required');
  await fail(provider.readGithubRepository({...site(),repositoryName:'evil'}),'owned_project_required');
  assert.equal(calls.length,0);
});

test('wrong-zone account and incomplete zone pagination never authorize Email Routing', async () => {
  const bad = rig({writes:true,override:{
    '/client/v4/zones':()=>Response.json(page([{
      id:zoneId,name:'example.com',status:'active',account:{id:'c'.repeat(32)}
    }]))
  }});
  await fail(bad.provider.readOwnedZone(site(),'www.example.com'),'owned_zone_required');
  const partial = rig({writes:true,override:{
    '/client/v4/zones':()=>Response.json({
      ...page([]),result_info:{page:1,total_pages:4}
    })
  }});
  await fail(partial.provider.readOwnedZone(site(),'www.example.com'),'provider_list_incomplete');
});

test('routing rule must be single literal recipient and single forwarding action', async () => {
  const {provider} = rig({writes:true});
  await provider.readOwnedZone(site(),'www.example.com');
  await fail(provider.createEmailRoutingRule(zoneId,{
    source:'api',enabled:true,
    matchers:[{type:'all'}],actions:[{type:'forward',value:['existing@example.net']}]
  }), 'unsafe_email_rule');
  await fail(provider.createEmailRoutingRule(zoneId,{
    source:'api',enabled:true,
    matchers:[{type:'literal',field:'to',value:'contact@www.example.com'}],
    actions:[{type:'worker',value:['arbitrary-worker']}]
  }), 'unsafe_email_rule');
});

test('provider HTTP failures and redirects never expose credentials or silently succeed', async () => {
  for (const [status, expected] of [
    [401,'provider_reauthentication_required'],
    [403,'provider_permission_required'],
    [429,'provider_rate_limited'],
    [302,'provider_operation_failed']
  ]) {
    const {provider} = rig({override:{
      ['/client/v4/accounts/'+account+'/pages/projects/esp-fern-site']:
        ()=>new Response(null,{status})
    }});
    await fail(provider.readPagesProject(site()),expected);
  }
});
