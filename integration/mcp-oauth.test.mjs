import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomBytes} from 'node:crypto';
import {readFileSync} from 'node:fs';
import worker from './bridge-worker.mjs';
import {createMemoryD1} from './d1-support.mjs';
import {mintBrowserLinkTicket} from './browser-link-ticket.mjs';
import {allowedRedirectUri} from './oauth-server.mjs';

const MCP = 'https://mcp.360web.cloud';
const REDIRECT = 'http://localhost:33418/callback';
const ticketKey = 'cd'.repeat(32);
const account = 'abcdef0123456789abcdef0123456789';

function setup() {
  const {db, sqlite} = createMemoryD1(['migrations/0001_bridge.sql', 'migrations/0002_oauth.sql',
    'migrations/0003_oauth_rate_limits.sql']);
  const env = {BRIDGE_DEPLOYMENT: 'approved', DB: db, BRIDGE_TICKET_KEY: ticketKey};
  const call = (path, init = {}) => worker.fetch(new Request(MCP + path, init), env);
  return {db, sqlite, env, call};
}

const form = fields => ({
  method: 'POST',
  headers: {'content-type': 'application/x-www-form-urlencoded', origin: MCP},
  body: new URLSearchParams(fields).toString()
});

async function authorize(call) {
  const reg = await call('/register', {
    method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({client_name: 'Claude Code', redirect_uris: [REDIRECT]})
  });
  assert.equal(reg.status, 201);
  const {client_id} = await reg.json();
  const verifier = randomBytes(32).toString('base64url');
  const params = {
    client_id, redirect_uri: REDIRECT, response_type: 'code', state: 'st1',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256', resource: MCP + '/mcp'
  };
  const page = await call('/authorize?' + new URLSearchParams(params));
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Claude Code/);
  const consent = await call('/authorize', form({...params, decision: 'allow'}));
  assert.equal(consent.status, 302);
  const back = new URL(consent.headers.get('location'));
  assert.equal(back.origin + back.pathname, REDIRECT);
  assert.equal(back.searchParams.get('state'), 'st1');
  return {client_id, verifier, params, code: back.searchParams.get('code')};
}

async function exchange(call, {client_id, verifier, code}) {
  return call('/token', form({
    grant_type: 'authorization_code', client_id, code, code_verifier: verifier,
    redirect_uri: REDIRECT, resource: MCP + '/mcp'
  }));
}

function rpc(call, token, method, params = {}, id = 1) {
  return call('/mcp', {
    method: 'POST',
    headers: {'content-type': 'application/json', authorization: 'Bearer ' + token,
      accept: 'application/json, text/event-stream'},
    body: JSON.stringify({jsonrpc: '2.0', id, method, params})
  });
}

test('discovery points MCP clients at the bridge authorization server', async () => {
  const {call} = setup();
  const unauth = await call('/mcp', {method: 'POST', body: '{}',
    headers: {'content-type': 'application/json'}});
  assert.equal(unauth.status, 401);
  assert.match(unauth.headers.get('www-authenticate'),
    /resource_metadata="https:\/\/mcp\.360web\.cloud\/\.well-known\/oauth-protected-resource"/);
  for (const path of ['/.well-known/oauth-protected-resource',
    '/.well-known/oauth-protected-resource/mcp']) {
    const meta = await (await call(path)).json();
    assert.deepEqual(meta.authorization_servers, [MCP]);
    assert.equal(meta.resource, MCP + '/mcp');
  }
  const as = await (await call('/.well-known/oauth-authorization-server')).json();
  assert.equal(as.issuer, MCP);
  assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
  assert.equal(as.registration_endpoint, MCP + '/register');
});

test('OAuth + MCP flow: unlinked session, browser link, then owner-scoped tools', async () => {
  const {call} = setup();
  const grant = await authorize(call);
  const tok = await exchange(call, grant);
  assert.equal(tok.status, 200);
  const {access_token, refresh_token} = await tok.json();
  assert.match(access_token, /^agt_/);

  const init = await (await rpc(call, access_token, 'initialize',
    {protocolVersion: '2025-06-18', capabilities: {}, clientInfo: {name: 't', version: '1'}})).json();
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.serverInfo.title, 'Launch & Own');
  assert.match(init.result.serverInfo.description, /Build and launch websites you own/);
  assert.equal(init.result.serverInfo.websiteUrl, 'https://onboard.360web.cloud');
  assert.deepEqual(init.result.serverInfo.icons, [{
    src: MCP + '/launch-and-own-icon.png',
    mimeType: 'image/png',
    sizes: ['128x128']
  }]);
  // The advertised PNG is public and loads from the MCP origin without a bearer.
  const iconPath = new URL(init.result.serverInfo.icons[0].src).pathname;
  const icon = await call(iconPath);
  assert.equal(icon.status, 200);
  assert.equal(icon.headers.get('content-type'), 'image/png');
  assert.equal(icon.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await icon.arrayBuffer()),
    readFileSync(new URL('../branding/launch-and-own-icon.png', import.meta.url)));
  const head = await call(iconPath, {method: 'HEAD'});
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-type'), 'image/png');
  assert.equal((await head.arrayBuffer()).byteLength, 0);

  const note = await call('/mcp', {method: 'POST',
    headers: {'content-type': 'application/json', authorization: 'Bearer ' + access_token},
    body: JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized'})});
  assert.equal(note.status, 202);

  const tools = (await (await rpc(call, access_token, 'tools/list')).json()).result.tools;
  assert.ok(tools.some(t => t.name === 'start_connect_accounts'));

  const status = (await (await rpc(call, access_token, 'tools/call',
    {name: 'get_connection_status', arguments: {}})).json()).result;
  assert.equal(status.structuredContent.linked, false);

  const blocked = (await (await rpc(call, access_token, 'tools/call',
    {name: 'list_sites', arguments: {}})).json()).result;
  assert.equal(blocked.isError, true);
  assert.match(blocked.content[0].text, /^needs_reauthorization/);

  const start = (await (await rpc(call, access_token, 'tools/call',
    {name: 'start_connect_accounts'})).json()).result.structuredContent;
  assert.match(start.action_url, /^https:\/\/onboard\.360web\.cloud\/agent-link\?challenge_id=link_/);

  // Onboarding (after real browser OAuth) posts a sealed ticket; no agent bearer.
  const ticket = await mintBrowserLinkTicket(ticketKey, {
    challengeId: start.challenge_id, githubUserId: 42, cloudflareAccountId: account,
    nowSeconds: Math.floor(Date.now() / 1000)
  });
  const linked = await call('/mcp/link/browser', {method: 'POST',
    headers: {'content-type': 'application/json'}, body: JSON.stringify({ticket})});
  assert.equal(linked.status, 200);

  const sites = (await (await rpc(call, access_token, 'tools/call',
    {name: 'list_sites', arguments: {}})).json()).result;
  assert.equal(sites.isError, undefined);
  assert.deepEqual(sites.structuredContent.sites, []);

  // Refresh keeps the same subject (link survives) and rotates the refresh token.
  const refreshed = await call('/token', form({
    grant_type: 'refresh_token', client_id: grant.client_id, refresh_token
  }));
  assert.equal(refreshed.status, 200);
  const next = await refreshed.json();
  const again = (await (await rpc(call, next.access_token, 'tools/call',
    {name: 'get_connection_status'})).json()).result.structuredContent;
  assert.equal(again.linked, true);
  assert.equal(again.github_user_id, 42);
  const unknown = await (await rpc(call, access_token, 'tools/call', {name: 'nope'})).json();
  assert.equal(unknown.error.code, -32602);
  const forged = (await (await rpc(call, access_token, 'tools/call',
    {name: 'get_connection_status', arguments: {subject: 'x'}})).json()).result;
  assert.equal(forged.isError, true);

  const replay = await call('/token', form({
    grant_type: 'refresh_token', client_id: grant.client_id, refresh_token
  }));
  assert.equal((await replay.json()).error, 'invalid_grant');
  assert.equal((await rpc(call, access_token, 'ping')).status, 401);
  assert.equal((await rpc(call, next.access_token, 'ping')).status, 401);
});

test('authorization codes are single-use and PKCE-bound', async () => {
  const {call} = setup();
  const grant = await authorize(call);
  const wrong = await exchange(call, {...grant, verifier: randomBytes(32).toString('base64url')});
  assert.equal((await wrong.json()).error, 'invalid_grant');
  assert.equal((await exchange(call, grant)).status, 200);
  assert.equal((await (await exchange(call, grant)).json()).error, 'invalid_grant');
});

test('consent refuses cross-site posts, unknown redirects and deny returns access_denied', async () => {
  const {call} = setup();
  const grant = await authorize(call);
  const cross = await call('/authorize', {...form({...grant.params, decision: 'allow'}),
    headers: {'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example'}});
  assert.equal(cross.status, 403);
  const nullOrigin = await call('/authorize', {...form({...grant.params, decision: 'allow'}),
    headers: {'content-type': 'application/x-www-form-urlencoded', origin: 'null'}});
  assert.equal(nullOrigin.status, 403);
  const bad = await call('/authorize?' + new URLSearchParams(
    {...grant.params, redirect_uri: 'https://evil.example/cb'}));
  assert.equal(bad.status, 400);
  const deny = await call('/authorize', form({...grant.params, decision: 'deny'}));
  assert.equal(new URL(deny.headers.get('location')).searchParams.get('error'), 'access_denied');
  const plain = await call('/authorize?' + new URLSearchParams(
    {...grant.params, code_challenge_method: 'plain'}));
  assert.equal(new URL(plain.headers.get('location')).searchParams.get('error'), 'invalid_request');
});

test('redirect URI policy: https or loopback http only', () => {
  assert.ok(allowedRedirectUri('https://chatgpt.com/connector_platform_oauth_redirect'));
  assert.ok(allowedRedirectUri('http://localhost:5555/callback'));
  assert.ok(allowedRedirectUri('http://127.0.0.1:5555/callback'));
  assert.ok(!allowedRedirectUri('http://example.com/cb'));
  assert.ok(!allowedRedirectUri('javascript:alert(1)'));
  assert.ok(!allowedRedirectUri('https://a.example/cb#frag'));
});

test('only a valid owner-origin RPC or a non-browser client can send MCP requests', async (t) => {
  const {sqlite, call} = setup();
  t.after(() => sqlite.close());
  const grant = await authorize(call);
  const {access_token} = await (await exchange(call, grant)).json();
  const init = origin => ({
    method: 'POST',
    headers: {'content-type': 'application/json', authorization: 'Bearer ' + access_token,
      ...(origin === undefined ? {} : {origin})},
    body: JSON.stringify({jsonrpc: '2.0', method: 'ping', id: 1})
  });
  for (const origin of [undefined, MCP])
    assert.equal((await call('/mcp', init(origin))).status, 200);
  for (const origin of ['https://unregistered.example', 'null'])
    assert.equal((await call('/mcp', init(origin))).status, 403);
  assert.equal((await call('/mcp/tools/call', init('https://unregistered.example'))).status, 403);
});

test('OAuth and MCP body limits apply to streamed input before parsing', async (t) => {
  const {sqlite, call} = setup();
  t.after(() => sqlite.close());
  const stream = length => new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('x'.repeat(length)));
      controller.close();
    }
  });
  const oversized = await call('/register', {
    method: 'POST', headers: {'content-type': 'application/json'},
    body: stream(8193), duplex: 'half'
  });
  assert.equal(oversized.status, 413);
  assert.equal(sqlite.prepare('SELECT count(*) AS count FROM bridge_oauth_clients').get().count, 0);
  const wrongType = await call('/authorize', {
    method: 'POST', headers: {origin: MCP, 'content-type': 'text/plain'}, body: 'synthetic'
  });
  assert.equal(wrongType.status, 415);
  const repeated = form({client_id: 'duplicate'});
  repeated.body += '&client_id=second';
  assert.equal((await call('/token', repeated)).status, 400);
  assert.equal((await call('/authorize?state=a&state=b')).status, 400);

  const grant = await authorize(call);
  const {access_token} = await (await exchange(call, grant)).json();
  const rpc = await call('/mcp', {
    method: 'POST', headers: {'content-type': 'application/json', authorization: 'Bearer ' + access_token},
    body: stream(65537), duplex: 'half'
  });
  assert.equal(rpc.status, 413);
  assert.equal((await rpc.json()).id, null);
  const ticket = await call('/mcp/link/browser', {
    method: 'POST', headers: {'content-type': 'application/json'}, body: stream(4097), duplex: 'half'
  });
  assert.equal(ticket.status, 413);
});

test('concurrent public registrations use a fixed D1 rate bucket and return Retry-After', async (t) => {
  const {sqlite, call} = setup();
  t.after(() => sqlite.close());
  t.mock.method(Date, 'now', () => 1_700_000_000_000);
  const submit = () => call('/register', {
    method: 'POST', headers: {'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.100'},
    body: JSON.stringify({redirect_uris: [REDIRECT]})
  });
  const responses = await Promise.all(Array.from({length: 15}, submit));
  assert.equal(responses.filter(response => response.status === 201).length, 12);
  for (const response of responses.filter(response => response.status !== 201)) {
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('retry-after'), '60');
  }
  assert.equal(sqlite.prepare('SELECT count(*) AS count FROM bridge_oauth_rate_limits').get().count, 1);
  assert.equal(sqlite.prepare('SELECT count(*) AS count FROM bridge_oauth_clients').get().count, 12);
});

test('a failed token insert leaves the one-time code usable for a retry', async (t) => {
  const {sqlite, call} = setup();
  t.after(() => sqlite.close());
  const grant = await authorize(call);
  sqlite.exec("CREATE TRIGGER fixture_fail_refresh BEFORE INSERT ON bridge_refresh_tokens " +
    "BEGIN SELECT RAISE(ABORT, 'test only'); END");
  const failed = await exchange(call, grant);
  assert.equal(failed.status, 503);
  assert.deepEqual(await failed.json(), {error: 'service_unavailable'});
  assert.equal(sqlite.prepare('SELECT used_at FROM bridge_oauth_codes').get().used_at, null);
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM bridge_agent_tokens').get().n, 0);
  sqlite.exec('DROP TRIGGER fixture_fail_refresh');

  const outcomes = await Promise.all([exchange(call, grant), exchange(call, grant)]);
  assert.deepEqual(outcomes.map(response => response.status).sort(), [200, 400]);
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM bridge_agent_tokens').get().n, 1);
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM bridge_refresh_tokens').get().n, 1);
});

test('refresh revocation clears the exact client grant, even with a concurrent rotation', async (t) => {
  const {sqlite, call} = setup();
  t.after(() => sqlite.close());
  const grant = await authorize(call);
  const other = await authorize(call);
  const initial = await (await exchange(call, grant)).json();
  const refresh = presented => call('/token', form({
    grant_type: 'refresh_token', client_id: grant.client_id, refresh_token: presented
  }));
  const revoke = clientId => call('/revoke', form({
    client_id: clientId, token: initial.refresh_token
  }));
  const prompt = await (await rpc(call, initial.access_token, 'tools/call',
    {name: 'start_connect_accounts'})).json();
  const ticket = await mintBrowserLinkTicket(ticketKey, {
    challengeId: prompt.result.structuredContent.challenge_id, githubUserId: 42,
    cloudflareAccountId: account, nowSeconds: Math.floor(Date.now() / 1000)
  });
  const link = () => call('/mcp/link/browser', {method: 'POST',
    headers: {'content-type': 'application/json'}, body: JSON.stringify({ticket})});
  assert.equal((await link()).status, 200);

  assert.equal((await revoke(other.client_id)).status, 200);
  assert.equal((await rpc(call, initial.access_token, 'ping')).status, 200);
  const [rotated, revoked] = await Promise.all([refresh(initial.refresh_token), revoke(grant.client_id)]);
  assert.equal(revoked.status, 200);
  if (rotated.status === 200) {
    const successor = await rotated.json();
    assert.equal((await rpc(call, successor.access_token, 'ping')).status, 401);
    assert.equal((await refresh(successor.refresh_token)).status, 400);
  } else assert.equal(rotated.status, 400);
  assert.equal((await rpc(call, initial.access_token, 'ping')).status, 401);
  assert.equal((await refresh(initial.refresh_token)).status, 400);
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM bridge_owner_links').get().n, 0);
  assert.equal((await link()).status, 400);
});

test('concurrent refresh replay revokes only the affected grant and its link challenges', async (t) => {
  const {sqlite, call} = setup();
  t.after(() => sqlite.close());
  const grant = await authorize(call);
  const independent = await authorize(call);
  const initial = await (await exchange(call, grant)).json();
  const other = await (await exchange(call, independent)).json();
  const refresh = (refreshToken, clientId = grant.client_id) => call('/token', form({
    grant_type: 'refresh_token', client_id: clientId, refresh_token: refreshToken
  }));
  const prompt = await (await rpc(call, initial.access_token, 'tools/call', {name: 'start_connect_accounts'})).json();
  const challenge = prompt.result.structuredContent.challenge_id;

  assert.equal((await refresh(initial.refresh_token, independent.client_id)).status, 400);
  assert.equal((await rpc(call, initial.access_token, 'ping')).status, 200);
  const responses = await Promise.all([refresh(initial.refresh_token), refresh(initial.refresh_token)]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 400]);
  const remaining = await responses.find(response => response.status === 200).json();
  assert.equal((await refresh(remaining.refresh_token)).status, 400);
  for (const token of [initial.access_token, remaining.access_token])
    assert.equal((await rpc(call, token, 'ping')).status, 401);
  assert.equal((await rpc(call, other.access_token, 'ping')).status, 200);
  assert.notEqual(sqlite.prepare('SELECT consumed_at FROM bridge_link_challenges WHERE id=?').get(challenge).consumed_at, null);
});
