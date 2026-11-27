// Customer-run assistant provisioning (ADR-001 B1, provisioning-plan.md).
// Automates preflight, D1, bootstrap Worker + KEK, and state/resume/rollback.
// Access policy and GitHub App install stay explicit owner pauses.
// Launch & Own never receives credentials. Nothing runs against live accounts unless the owner runs this CLI.
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_MANIFEST = join(ROOT, 'provisioning', 'manifest.json');
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const SHA = /^[a-f0-9]{40}$/i;
const STEPS = ['preflight', 'repo', 'd1', 'worker', 'access', 'github-app', 'install', 'self-check'];

export function fillName(template, { owner, siteSlug }) {
  return String(template || '').replaceAll('{owner}', owner).replaceAll('{siteSlug}', siteSlug);
}

export function consentText({ owner, siteSlug, workersPlan = 'free', email = '<owner email>', websiteRepo }) {
  const paid = workersPlan === 'paid'
    ? 'Your account is on Workers Paid. Usage above the included amounts is billed by Cloudflare (Workers AI: $0.011 per 1,000 Neurons). The assistant\'s daily budget limits this, but Cloudflare bills your account directly.'
    : 'On the Workers Free plan these fit within free limits: 100,000 requests/day, 10,000 Workers AI Neurons/day, and D1\'s free rows and storage. If a daily limit is reached, the assistant stops until the next day (midnight UTC). You are not charged.';
  return [
    'Set up your private website assistant',
    '',
    'This creates the following in your accounts. Launch & Own does not receive access to any of it.',
    '',
    'GitHub (' + owner + ')',
    '- Private repository ' + owner + '/' + siteSlug + '-assistant',
    '- Private GitHub App ' + siteSlug + '-assistant, installed only on ' + websiteRepo,
    '',
    'Cloudflare',
    '- Worker lo-assistant-' + siteSlug,
    '- D1 database lo-assistant-' + siteSlug,
    '- Workers AI from your daily allocation (budget 8,000 Neurons/day)',
    '- An Access application that lets only ' + email + ' sign in (you create this in the Cloudflare dashboard)',
    '',
    'Cost. ' + paid + ' Domain registration and other services are separate. Limits are set by the providers and can change.',
    '',
    'Removing it. Delete the GitHub App, the Worker, the D1 database and the Access application. See assistant/UNINSTALL.md. Your website and its history stay untouched.',
    '',
    'You will pause twice: once to create the Access app, once to install the GitHub App on only the website repo.'
  ].join('\n');
}

export function accessGuide({ siteSlug, origin }) {
  return [
    'Manual step: Cloudflare Access',
    '1. Open https://one.dash.cloudflare.com/ and create an Access application named Launch & Own Assistant (' + siteSlug + ').',
    '2. Application domain: ' + origin.replace(/^https:\/\//, ''),
    '3. Policy: Allow only your email. Session duration ≤ 24 hours.',
    '4. Copy the team domain and Application Audience (AUD).',
    '5. Resume this script with those values; it writes them into wrangler.jsonc and redeploys.',
    'Until Access is configured, every route except /healthz returns 503.'
  ].join('\n');
}

export function installGuide({ appSlug, websiteRepo }) {
  return [
    'Manual step: install the GitHub App',
    '1. Open https://github.com/apps/' + encodeURIComponent(appSlug) + '/installations/new',
    '2. Choose Only select repositories → ' + websiteRepo + ' (never the assistant repo).',
    '3. Copy the installation id and the website repository numeric id.',
    '4. Resume this script so it can store GH_INSTALLATION_ID and WEBSITE_REPO_ID.'
  ].join('\n');
}

export function newState({ siteSlug, owner, websiteRepo, upstreamSha, runId = randomUUID() }) {
  return {
    version: 1,
    runId,
    siteSlug,
    owner,
    websiteRepo,
    upstreamSha,
    createdAt: new Date().toISOString(),
    steps: Object.fromEntries(STEPS.map(id => [id, { status: 'pending' }])),
    createdThisRun: [],
    secrets: [],
    access: null,
    githubApp: null,
    install: null
  };
}

export function statePath(dir, runId) {
  return join(dir, 'state.' + runId + '.json');
}

export async function loadManifest(path = DEFAULT_MANIFEST) {
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function saveState(path, state) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
}

function runCmd(cmd, args, { cwd, env, spawnFn = spawn } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawnFn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', c => { out += c; });
    child.stderr.on('data', c => { err += c; });
    child.on('error', reject);
    child.on('exit', code => code === 0
      ? resolvePromise({ code, out, err })
      : reject(Object.assign(Error(cmd + ' ' + args.join(' ') + ' exited ' + code), { code, out, err })));
  });
}

export function defaultAdapters({ cwd = process.cwd(), spawnFn = spawn } = {}) {
  const wrangler = (args) => runCmd('npx', ['wrangler', ...args], { cwd, spawnFn });
  return {
    nodeVersion: () => process.versions.node,
    whoami: async () => {
      const { out } = await wrangler(['whoami']);
      return out;
    },
    listD1: async () => {
      const { out } = await wrangler(['d1', 'list', '--json']);
      try { return JSON.parse(out); } catch { return []; }
    },
    createD1: async (name) => {
      const { out } = await wrangler(['d1', 'create', name]);
      const id = /database_id\s*[:=]\s*["']?([0-9a-f-]{36})/i.exec(out)?.[1] || null;
      return { name, id, out };
    },
    migrateD1: async (name) => wrangler(['d1', 'migrations', 'apply', name, '--remote']),
    deleteD1: async (name) => wrangler(['d1', 'delete', name, '--skip-confirmation']),
    deploy: async () => wrangler(['deploy']),
    deleteWorker: async (name) => wrangler(['delete', name, '--force']),
    secretPut: async (name, value) => {
      await new Promise((resolvePromise, reject) => {
        const child = spawnFn('npx', ['wrangler', 'secret', 'put', name], { cwd, stdio: ['pipe', 'ignore', 'inherit'] });
        child.on('error', reject);
        child.on('exit', code => code === 0 ? resolvePromise() : reject(Error('secret put ' + name + ' exited ' + code)));
        child.stdin.end(value);
      });
    },
    ensureRepo: async () => { throw Error('ensureRepo adapter required for live runs (create private assistant repo from the pinned template)'); },
    deleteRepo: async () => { throw Error('deleteRepo adapter required'); },
    healthz: async (origin) => {
      const response = await fetch(origin + '/healthz', { redirect: 'manual' });
      return { status: response.status, body: await response.text() };
    },
    selfCheck: async (origin, headers = {}) => {
      const response = await fetch(origin + '/self-check', { method: 'POST', headers: { ...headers, origin }, redirect: 'manual' });
      return { status: response.status, body: await response.text() };
    },
    writeWranglerVars: async () => { throw Error('writeWranglerVars adapter required for live runs'); },
    runManifestExchange: async () => { throw Error('runManifestExchange adapter required for live runs'); }
  };
}

export async function preflight(input, adapters) {
  const node = adapters.nodeVersion();
  const parts = String(node).split('.').map(Number);
  if (parts[0] < 22 || (parts[0] === 22 && parts[1] < 12)) {
    return { ok: false, errors: ['Node ≥ 22.12 required (got ' + node + ')'] };
  }
  if (!SLUG.test(input.siteSlug)) return { ok: false, errors: ['invalid siteSlug'] };
  if (!SHA.test(input.upstreamSha || '')) return { ok: false, errors: ['upstreamSha must be a 40-hex commit'] };
  if (!/^[\w.-]+\/[\w.-]+$/.test(input.websiteRepo || '')) return { ok: false, errors: ['invalid websiteRepo'] };
  const who = await adapters.whoami();
  const d1 = await adapters.listD1();
  const count = Array.isArray(d1) ? d1.length : (d1?.result?.length ?? 0);
  const errors = [];
  if (count >= 10) errors.push('D1 database limit reached (10)');
  return {
    ok: errors.length === 0,
    errors,
    report: {
      node,
      wranglerWhoami: who.trim().slice(0, 500),
      d1Count: count,
      workersPlan: input.workersPlan || 'unknown'
    }
  };
}

export async function runProvision(input, {
  adapters,
  prompt,
  stateDir = join(ROOT, 'provisioning'),
  dryRun = false,
  resumePath = null
} = {}) {
  if (!adapters) throw Error('adapters required');
  let state;
  let path;
  if (resumePath) {
    state = JSON.parse(await readFile(resumePath, 'utf8'));
    path = resumePath;
  } else {
    state = newState(input);
    path = statePath(stateDir, state.runId);
  }

  const mark = async (step, status, detail = {}) => {
    state.steps[step] = { status, ...detail, at: new Date().toISOString() };
    await saveState(path, state);
  };

  const ask = async (question) => {
    if (typeof prompt === 'function') return prompt(question);
    throw Error('interactive prompt required for: ' + question);
  };

  // Step 0
  if (state.steps.preflight.status !== 'done') {
    const check = await preflight(input, adapters);
    if (!check.ok) throw Error('preflight failed: ' + check.errors.join('; '));
    const consent = consentText({
      owner: input.owner, siteSlug: input.siteSlug, websiteRepo: input.websiteRepo,
      workersPlan: input.workersPlan || 'free', email: input.email
    });
    if (!dryRun) {
      const answer = await ask(consent + '\n\nType YES to continue: ');
      if (String(answer).trim() !== 'YES') throw Error('consent declined');
    }
    await mark('preflight', 'done', { report: check.report, dryRun });
  }

  const workerName = 'lo-assistant-' + state.siteSlug;
  const d1Name = 'lo-assistant-' + state.siteSlug;
  const origin = input.origin || ('https://' + workerName + '.workers.dev');

  // Step 1 repo
  if (state.steps.repo.status !== 'done') {
    if (dryRun) await mark('repo', 'done', { dryRun: true, name: state.owner + '/' + state.siteSlug + '-assistant' });
    else {
      const created = await adapters.ensureRepo({
        owner: state.owner, siteSlug: state.siteSlug, upstreamSha: state.upstreamSha
      });
      if (created?.created) state.createdThisRun.push({ id: 'assistant-repo', name: created.name });
      await mark('repo', 'done', { name: created?.name });
    }
  }

  // Step 2 D1
  if (state.steps.d1.status !== 'done') {
    if (dryRun) await mark('d1', 'done', { dryRun: true, name: d1Name });
    else {
      const created = await adapters.createD1(d1Name);
      state.createdThisRun.push({ id: 'd1', name: d1Name, databaseId: created.id });
      await adapters.migrateD1(d1Name);
      await mark('d1', 'done', { name: d1Name, databaseId: created.id });
    }
  }

  // Step 3 Worker + KEK
  if (state.steps.worker.status !== 'done') {
    if (dryRun) await mark('worker', 'done', { dryRun: true, name: workerName });
    else {
      const kek = randomBytes(32).toString('base64url');
      await adapters.deploy();
      state.createdThisRun.push({ id: 'worker', name: workerName });
      await adapters.secretPut('KEK', kek);
      state.secrets.push('KEK');
      const health = await adapters.healthz(origin);
      if (health.status !== 200) throw Error('/healthz failed: ' + health.status);
      await mark('worker', 'done', { name: workerName, origin });
    }
  }

  // Step 4 Access (manual pause)
  if (state.steps.access.status !== 'done') {
    if (dryRun) await mark('access', 'done', { dryRun: true });
    else {
      await mark('access', 'waiting', { guide: accessGuide({ siteSlug: state.siteSlug, origin }) });
      const teamDomain = String(await ask(accessGuide({ siteSlug: state.siteSlug, origin }) + '\n\nAccess team domain: ')).trim();
      const aud = String(await ask('Access AUD: ')).trim();
      const ownerSub = String(await ask('Your Access sub (from a JWT or /cdn-cgi/access/get-identity): ')).trim();
      if (!teamDomain || !aud || !ownerSub) throw Error('Access values required');
      await adapters.writeWranglerVars({
        ACCESS_TEAM_DOMAIN: teamDomain, ACCESS_AUD: aud, OWNER_SUB: ownerSub, ASSISTANT_ORIGIN: origin
      });
      await adapters.deploy();
      state.access = { teamDomain, aud, ownerSub };
      await mark('access', 'done', { teamDomain, audSet: true });
    }
  }

  // Step 5 GitHub App exchange
  if (state.steps['github-app'].status !== 'done') {
    if (dryRun) await mark('github-app', 'done', { dryRun: true });
    else {
      const result = await adapters.runManifestExchange({
        name: state.siteSlug + '-assistant',
        origin,
        repo: state.websiteRepo
      });
      state.githubApp = { appId: result.appId, slug: result.slug };
      if (result.appId) {
        await adapters.writeWranglerVars({ GH_APP_ID: String(result.appId) });
        state.secrets.push('GH_APP_PRIVATE_KEY');
      }
      await mark('github-app', 'done', state.githubApp);
    }
  }

  // Step 6 install (manual pause)
  if (state.steps.install.status !== 'done') {
    if (dryRun) await mark('install', 'done', { dryRun: true });
    else {
      const slug = state.githubApp?.slug || (state.siteSlug + '-assistant');
      await mark('install', 'waiting', { guide: installGuide({ appSlug: slug, websiteRepo: state.websiteRepo }) });
      const installationId = String(await ask(installGuide({ appSlug: slug, websiteRepo: state.websiteRepo }) + '\n\nInstallation id: ')).trim();
      const repoId = String(await ask('Website repository id: ')).trim();
      if (!/^\d+$/.test(installationId) || !/^\d+$/.test(repoId)) throw Error('installation id and repo id must be numeric');
      await adapters.secretPut('GH_INSTALLATION_ID', installationId);
      await adapters.writeWranglerVars({
        GH_INSTALLATION_ID: installationId, WEBSITE_REPO_ID: repoId,
        WEBSITE_OWNER: state.websiteRepo.split('/')[0], WEBSITE_REPO: state.websiteRepo.split('/')[1]
      });
      await adapters.deploy();
      state.install = { installationId, repoId };
      state.secrets.push('GH_INSTALLATION_ID');
      await mark('install', 'done', state.install);
    }
  }

  // Step 7 self-check
  if (state.steps['self-check'].status !== 'done') {
    if (dryRun) await mark('self-check', 'done', { dryRun: true });
    else {
      const check = await adapters.selfCheck(origin);
      if (check.status !== 200) throw Error('self-check failed: ' + check.status + ' ' + check.body.slice(0, 200));
      await mark('self-check', 'done', { result: check.body.slice(0, 500) });
    }
  }

  return { state, path, dryRun };
}

export async function rollback(state, adapters) {
  const created = [...(state.createdThisRun || [])].reverse();
  const report = [];
  for (const item of created) {
    if (item.id === 'worker') {
      await adapters.deleteWorker(item.name);
      report.push('deleted worker ' + item.name);
    } else if (item.id === 'd1') {
      await adapters.deleteD1(item.name);
      report.push('deleted d1 ' + item.name);
    } else if (item.id === 'assistant-repo') {
      await adapters.deleteRepo(item.name);
      report.push('deleted repo ' + item.name);
    }
  }
  return report;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (name) => {
    const i = process.argv.indexOf('--' + name);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const dryRun = process.argv.includes('--dry-run');
  const resume = arg('resume');
  const siteSlug = arg('site-slug');
  const owner = arg('owner');
  const websiteRepo = arg('website-repo');
  const upstreamSha = arg('upstream-sha');
  const email = arg('email') || '<owner email>';
  const origin = arg('origin');
  const workersPlan = arg('workers-plan') || 'free';

  if (!resume && (!siteSlug || !owner || !websiteRepo || !upstreamSha)) {
    console.error('Usage: node assistant/setup/provision.mjs --site-slug <slug> --owner <login> --website-repo <owner/repo> --upstream-sha <40hex> [--dry-run]\n   or: node assistant/setup/provision.mjs --resume <provisioning/state.<runId>.json>');
    process.exit(2);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const adapters = defaultAdapters({ cwd: process.cwd() });
    // Live repo/wrangler-var helpers stay explicit so dry-run and tests do not invent provider writes.
    adapters.ensureRepo = async ({ owner: o, siteSlug: s }) => {
      console.log('Create private repo ' + o + '/' + s + '-assistant from the pinned upstream template, then press Enter.');
      await rl.question('');
      return { name: o + '/' + s + '-assistant', created: true };
    };
    adapters.writeWranglerVars = async (vars) => {
      console.log('Set these in wrangler.jsonc (then this script redeploys):');
      console.log(JSON.stringify(vars, null, 2));
      await rl.question('Press Enter after editing wrangler.jsonc: ');
    };
    adapters.runManifestExchange = async ({ name, origin: o, repo }) => {
      console.log('Run: node assistant/setup/manifest-exchange.mjs --name ' + name + ' --origin ' + o + ' --repo ' + repo);
      const appId = await rl.question('GH_APP_ID: ');
      const slug = await rl.question('App slug: ');
      return { appId: Number(appId), slug, secretSaved: true };
    };
    const input = resume
      ? JSON.parse(await readFile(resume, 'utf8'))
      : { siteSlug, owner, websiteRepo, upstreamSha, email, origin, workersPlan };
    const result = await runProvision(resume ? {
      siteSlug: input.siteSlug, owner: input.owner, websiteRepo: input.websiteRepo,
      upstreamSha: input.upstreamSha, email, origin, workersPlan
    } : input, {
      adapters,
      prompt: q => rl.question(q),
      dryRun,
      resumePath: resume || null
    });
    console.log('State saved at ' + result.path);
    console.log(dryRun ? 'Dry run complete. No provider resources were created.' : 'Provisioning complete. Open ' + (origin || ('https://lo-assistant-' + result.state.siteSlug + '.workers.dev')) + '/status');
  } finally {
    rl.close();
  }
}
