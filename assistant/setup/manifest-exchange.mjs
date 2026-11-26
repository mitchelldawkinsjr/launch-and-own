// Customer-run GitHub App setup (ADR-002 A3). Runs on the customer's own machine:
//   node assistant/setup/manifest-exchange.mjs --name <site>-assistant --origin https://assistant.example.com --repo owner/site
// The private key goes straight from GitHub into `wrangler secret put GH_APP_PRIVATE_KEY` via stdin.
// It is never written to disk, logged, or sent anywhere else. client_secret is discarded (the assistant has no user OAuth).
import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const APP_PERMISSIONS = Object.freeze({ contents: 'write', pull_requests: 'write', metadata: 'read' });
const escape = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const page = (status, body) => ({ status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }, body: '<!doctype html><meta charset="utf-8"><title>Assistant setup</title>' + body });

export function buildManifest({ name, origin, port }) {
  if (!/^[a-z0-9][a-z0-9-]{1,32}$/.test(name || '')) throw Error('invalid_app_name');
  if (!/^https:\/\/[a-z0-9.-]+$/i.test(origin || '')) throw Error('invalid_origin');
  return {
    name, url: origin, public: false,
    redirect_url: 'http://127.0.0.1:' + port + '/callback',
    hook_attributes: { url: origin + '/no-webhooks', active: false }, // webhooks off: the assistant polls
    default_permissions: APP_PERMISSIONS, default_events: []
  };
}

/** One-shot local handler. `writeSecret(name, value)` must deliver `value` without echoing it. */
export function setupHandler({ name, origin, repo, port, fetchFn = fetch, writeSecret, state = randomBytes(16).toString('hex') }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '')) throw Error('invalid_repo');
  const manifest = buildManifest({ name, origin, port });
  let done = false;
  return async ({ method, url, host }) => {
    // Only requests addressed to this local server (blocks DNS rebinding).
    if (host !== '127.0.0.1:' + port && host !== 'localhost:' + port) return { status: 421, headers: {}, body: 'Local setup only' };
    const u = new URL(url, 'http://127.0.0.1:' + port);
    if (method === 'GET' && u.pathname === '/') {
      return page(200, '<p>This creates a <strong>private GitHub App</strong> named <code>' + escape(name) + '</code> in your account. It can read files and open pull requests. It cannot merge, change settings or edit workflows.</p>' +
        '<form method="post" action="https://github.com/settings/apps/new?state=' + state + '"><input type="hidden" name="manifest" value="' + escape(JSON.stringify(manifest)) + '"><button>Create the app on GitHub</button></form>');
    }
    if (method === 'GET' && u.pathname === '/callback') {
      const given = Buffer.from(u.searchParams.get('state') || ''), want = Buffer.from(state);
      if (done || given.length !== want.length || !timingSafeEqual(given, want)) return page(400, '<p>This setup link is not valid. Start the setup again.</p>');
      const code = u.searchParams.get('code') || '';
      if (!/^[\w-]{8,100}$/.test(code)) return page(400, '<p>GitHub did not return a setup code.</p>');
      done = true; // the code is a bearer secret valid for one hour: use it once, never retry
      const response = await fetchFn('https://api.github.com/app-manifests/' + code + '/conversions', {
        method: 'POST', redirect: 'manual', headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'launch-and-own-assistant-setup' }
      });
      if (response.status !== 201) return page(502, '<p>GitHub refused the setup code (' + response.status + '). Start the setup again.</p>');
      const app = await response.json();
      if (!Number.isSafeInteger(app?.id) || typeof app.pem !== 'string' || typeof app.slug !== 'string') return page(502, '<p>GitHub returned an unexpected app.</p>');
      await writeSecret('GH_APP_PRIVATE_KEY', app.pem);
      const install = 'https://github.com/apps/' + encodeURIComponent(app.slug) + '/installations/new';
      return { ...page(200, '<p>Created <code>' + escape(app.slug) + '</code>. Its private key is stored as a Worker secret.</p>' +
        '<ol><li>Set <code>GH_APP_ID</code> to <code>' + app.id + '</code> in <code>wrangler.jsonc</code>.</li>' +
        '<li><a href="' + install + '" target="_blank" rel="noopener noreferrer">Install it</a> with <strong>Only select repositories</strong> → <code>' + escape(repo) + '</code>. Never on the assistant repository.</li></ol>'),
        result: { appId: app.id, slug: app.slug } };
    }
    return { status: 404, headers: {}, body: 'Not found' };
  };
}

/** Pipe the value into `wrangler secret put` on stdin, so it never appears in argv, logs or files. */
export function wranglerSecretWriter({ cwd = process.cwd(), spawnFn = spawn } = {}) {
  return (name, value) => new Promise((resolve, reject) => {
    const child = spawnFn('npx', ['wrangler', 'secret', 'put', name], { cwd, stdio: ['pipe', 'ignore', 'inherit'] });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(Error('wrangler secret put exited ' + code)));
    child.stdin.end(value);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = n => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : undefined; };
  const port = Number(arg('port') || 8790);
  const handler = setupHandler({ name: arg('name'), origin: arg('origin'), repo: arg('repo'), port, writeSecret: wranglerSecretWriter() });
  const server = http.createServer(async (req, res) => {
    const out = await handler({ method: req.method, url: req.url, host: req.headers.host });
    res.writeHead(out.status, out.headers); res.end(out.body);
    if (out.result) { console.log('GitHub App created:', out.result.slug, 'id', out.result.appId); server.close(); }
  });
  server.listen(port, '127.0.0.1', () => console.log('Open http://127.0.0.1:' + port + '/ to create the assistant GitHub App.'));
}
