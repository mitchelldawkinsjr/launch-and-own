// Local onboarding Worker with mocked GitHub/Cloudflare, for screen-reader and visual QA. Never touches real providers.
// Usage: node scripts/serve-onboarding-mock.mjs [--zip] [--port 8787] [--repo <checkout of the release commit>]
// Requires Node 22.5+ (node:sqlite). Provider consent screens are skipped; every account is a fake test fixture.
// QA ONLY. Never expose it, bind it beyond 127.0.0.1, give it real secrets or real provider fetch, or deploy it.
import http from 'node:http';
import {pathToFileURL, fileURLToPath} from 'node:url';

export async function startMockServer({repo = fileURLToPath(new URL('..', import.meta.url)), port = 8787, zip = false} = {}) {
  const {harness, origin} = await import(pathToFileURL(repo + '/onboarding/worker-test-support.mjs'));
  const h = harness();
  globalThis.fetch = h.fetchFn;
  // Same fake ZIP configuration the Worker tests use; enables the ZIP-first landing copy and upload form.
  if (zip) Object.assign(h.env, {ZIP_ARTIFACTS: {put() {}, get() { return null; }, delete() {}},
    ZIP_PREVIEW_DOMAIN: 'preview.example.test', ZIP_PREVIEW_KEY: 'cd'.repeat(32)});
  const server = http.createServer(async (req, res) => {
    try {
      // Only requests addressed to this local server (blocks DNS rebinding); only same-page origins are trusted.
      const local = ['127.0.0.1', 'localhost'].map(h => h + ':' + server.address().port);
      if (!local.includes(req.headers.host)) { res.writeHead(421, {'content-type': 'text/plain'}); return res.end('Local QA server only'); }
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const headers = {...req.headers};
      delete headers.host;
      if (headers.origin === undefined) delete headers.origin;
      else if (local.some(h => headers.origin === 'http://' + h)) headers.origin = origin; // other origins pass through and fail the Worker's check
      const r = await h.request(req.url, {method: req.method, cookie: req.headers.cookie, headers,
        body: req.method === 'POST' && chunks.length ? Buffer.concat(chunks) : undefined});
      const out = {};
      r.headers.forEach((v, k) => { if (k !== 'set-cookie') out[k] = v; });
      const loc = r.headers.get('location');
      if (loc) {
        const u = new URL(loc, origin);
        // Mock consent: go straight to the local OAuth callback with the harness's accepted test codes.
        if (u.hostname === 'github.com' && u.pathname.includes('authorize'))
          out.location = '/oauth/github/callback?code=good&state=' + encodeURIComponent(u.searchParams.get('state') || '');
        else if (u.hostname.endsWith('cloudflare.com') && u.searchParams.get('state'))
          out.location = '/oauth/cloudflare/callback?code=valid&state=' + encodeURIComponent(u.searchParams.get('state'));
        else out.location = u.origin === origin ? u.pathname + u.search : loc;
      }
      res.writeHead(r.status, {...out, 'set-cookie': r.headers.getSetCookie()});
      res.end(Buffer.from(await r.arrayBuffer()));
    } catch (e) {
      res.writeHead(500, {'content-type': 'text/plain'});
      res.end(String(e?.stack || e));
    }
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const server = await startMockServer({repo: opt('--repo'), port: Number(opt('--port') || 8787), zip: args.includes('--zip')});
  console.log('Launch & Own onboarding, mocked providers: http://localhost:' + server.address().port + '/');
}
