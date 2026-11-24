import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, statSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {RESOURCE_URI} from '../../integration/protected-resource.mjs';
import {SERVER_INFO} from '../../integration/mcp-jsonrpc.mjs';
import {authorizationServerMetadata, SCOPE} from '../../integration/oauth-server.mjs';
import {TOOLS} from '../../integration/mcp-jsonrpc.mjs';
import {loadDistributionMatrix} from '../../distribution/release-gates.mjs';

const file=path=>readFileSync(fileURLToPath(new URL(path,import.meta.url)),'utf8');
const plugin=JSON.parse(file('./plugin.json'));
const mcp=JSON.parse(file('./mcp.json'));
const skill=file('./skills/launch-and-own-connected/SKILL.md');
const server=mcp.mcpServers['launch-and-own'];

test('ChatGPT distribution bundle declares a valid private-capable plugin identity',()=>{
  assert.equal(plugin.$schema,'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
  assert.equal(plugin.name,'launch-and-own');
  assert.match(plugin.version,/^\d+\.\d+\.\d+$/);
  assert.equal(plugin.extensions['com.openai'].interface.displayName,'Launch & Own');
  assert.ok(plugin.extensions['com.openai'].interface.shortDescription.length<=30);
  assert.equal(plugin.extensions['com.openai'].interface.category,'Productivity');
  assert.deepEqual(plugin.extensions['com.openai'].interface.capabilities,['Interactive']);
  assert.equal(plugin.repository,'https://github.com/mitchelldawkinsjr/launch-and-own');
});

test('ChatGPT MCP package reuses the deployed shared bridge without parallel provisioning stack',()=>{
  assert.equal(mcp.$schema,'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json');
  assert.deepEqual(Object.keys(mcp.mcpServers),['launch-and-own']);
  assert.equal(server.type,'streamable-http');
  assert.equal(server.url,RESOURCE_URI);
  assert.equal(server.url,'https://mcp.360web.cloud/mcp');
  assert.equal(server.extensions['com.openai'].auth.type,'oauth');
  assert.deepEqual(server.extensions['com.openai'].auth.client,{mode:'dcr'});
  assert.deepEqual(server.extensions['com.openai'].auth.baseScopes,[SCOPE]);
  assert.deepEqual(server.extensions['com.openai'].auth.defaultScopes,[SCOPE]);
  assert.equal(server.extensions['com.openai'].auth.oidcEnabled,false);
  assert.equal(authorizationServerMetadata().registration_endpoint,
    'https://mcp.360web.cloud/register');
  assert.equal(authorizationServerMetadata().token_endpoint_auth_methods_supported[0],'none');
  assert.equal(TOOLS.length,10);
  assert.equal(new Set(TOOLS.map(x=>x.name)).size,10);
});

test('plugin skill uses connected tools but requires separate human approval and honest status',()=>{
  assert.match(skill,/^---\nname: launch-and-own-connected\n/);
  for(const tool of TOOLS) assert.ok(skill.includes('`'+tool.name+'`'),
    'Missing shared MCP tool coverage '+tool.name);
  for(const phrase of ['get_connection_status','start_connect_accounts','prepare_site',
    'get_exact_preview','request_explicit_approval','verify_publication',
    'needs_reauthorization','not_implemented','Upload a built website',
    'idempotency key','browser consent','GitHub','Cloudflare','last_verified'])
    assert.ok(skill.includes(phrase),'Missing safety requirement '+phrase);
  assert.match(skill,/not.*published/i);
  assert.match(skill,/NEVER|Never/);
  assert.doesNotMatch(skill,/paste (?:your )?(?:API )?(?:key|token|password) here/i);
  assert.doesNotMatch(JSON.stringify(mcp),/(?:sk-|ghp_|github_pat_|cf_[a-zA-Z0-9]{20,})/i);
});

test('private beta packaging cannot silently promote public ChatGPT release claims',()=>{
  const matrix=loadDistributionMatrix();
  assert.equal(matrix.surfaces.chatgpt_connector.access,'not_available');
  assert.notEqual(matrix.surfaces.chatgpt_connector.verification,'independent_live');
  assert.equal(matrix.ownerConsent.agentMayPublishUnilaterally,false);
  assert.equal(matrix.ownerConsent.providerCredentialsExposedToAgent,false);
  assert.match(file('./README.md'),/private beta/i);
});

test('browser install guidance truthfully documents uploaded MCP ZIP Desktop only caveat',()=>{
  const instructions=file('./README.md');
  assert.match(instructions,/Desktop only/);
  assert.match(instructions,/Add custom MCP server/);
  assert.match(instructions,/https:\/\/mcp\.360web\.cloud\/mcp/);
  assert.match(instructions,/DCR/);
  assert.match(instructions,/Business and Enterprise\/Edu/);
  assert.match(instructions,/do not promise/i);
  assert.match(instructions,/ChatGPT desktop app/);
  assert.match(instructions,/https:\/\/onboard\.360web\.cloud/);
});


test('branding icon is a real PNG and is referenced by the plugin and MCP metadata',()=>{
  const iconPath = fileURLToPath(new URL('./assets/launch-and-own-icon.png', import.meta.url));
  const png = readFileSync(iconPath);
  assert.ok(statSync(iconPath).size > 1000);
  assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
  assert.equal(png.readUInt32BE(16),128);
  assert.equal(png.readUInt32BE(20),128);
  const iconRel = './assets/launch-and-own-icon.png';
  assert.equal(plugin.extensions['com.openai'].interface.logo,iconRel);
  assert.equal(plugin.extensions['com.openai'].interface.composerIcon,iconRel);
  const branded = SERVER_INFO.icons[0];
  assert.equal(branded.src,'https://raw.githubusercontent.com/mitchelldawkinsjr/launch-and-own/main/branding/launch-and-own-icon.png');
  assert.deepEqual(branded.sizes,['128x128']);
});
