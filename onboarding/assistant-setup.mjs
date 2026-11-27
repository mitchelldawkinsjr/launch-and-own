/**
 * Hosted assistant setup wizard (ADR-001 D-style pilot). Browser-only; no wrangler.
 * Gated by OPTION_ASSISTANT_BOOTSTRAP_ENABLED. Marketing stays "planned" until the matrix updates.
 */
import { getOwnedJob, isLaunchId } from './launch-jobs.mjs';
import { getFreshAccessToken } from './token-lifecycle.mjs';
import {
  assistantBootstrapEnabled, createAssistantBootstrapStore
} from './assistant-bootstrap-store.mjs';
import {
  accessGuideMarkup, applyAccessVars, applyGithubInstall, consentMarkup,
  createAssistantResources, installGuideMarkup, putGithubAppPrivateKey
} from './assistant-bootstrap.mjs';

const SHA = /^[a-f0-9]{40}$/i;

export function assistantScopes(env) {
  return env.OPTION_ASSISTANT_BOOTSTRAP_ENABLED === 'true'
    ? String(env.CF_ASSISTANT_SCOPES || '').trim().split(/\s+/)
      .filter(scope => scope === 'workers-scripts.admin' || /^[a-z0-9-]+\.(?:read|write)$/.test(scope))
    : [];
}

export function assistantScopesGranted(env, scope) {
  if (typeof scope !== 'string' || !scope.trim()) return true;
  const granted = new Set(scope.trim().split(/\s+/));
  return assistantScopes(env).every(s => granted.has(s));
}

function websiteRepoForJob(job) {
  const login = job.github_login;
  const slug = job.site_slug;
  if (typeof login !== 'string' || typeof slug !== 'string') return null;
  // Launch repos are esp-<site_slug> in this product.
  return login + '/esp-' + slug;
}

function upstreamSha(env) {
  const sha = String(env.ASSISTANT_UPSTREAM_SHA || '').toLowerCase();
  return SHA.test(sha) ? sha : '0'.repeat(40);
}

function stepOrder(step) {
  return ['consent', 'cf_grant', 'create', 'access', 'github_app', 'install', 'ready', 'failed'].indexOf(step);
}

function progress(currentStep) {
  const steps = [
    ['consent', 'Consent'],
    ['cf_grant', 'Cloudflare allow'],
    ['create', 'Create resources'],
    ['access', 'Access'],
    ['github_app', 'GitHub App'],
    ['install', 'Install App'],
    ['ready', 'Ready']
  ];
  const at = stepOrder(currentStep === 'failed' ? 'create' : currentStep);
  return '<ol class="lo-steps" aria-label="Assistant setup progress">' + steps.map(([id, label], i) => {
    const state = i < at ? 'is-done' : (i === at ? 'is-active' : '');
    return '<li class="' + state + '"><strong>' + label + '</strong></li>';
  }).join('') + '</ol>';
}

export function createAssistantSetupRoutes({ view, fail, escape, button, assertCsrf, formData, now, redirect }) {
  async function loadLiveJob(env, current, id) {
    if (!assistantBootstrapEnabled(env)) return { error: fail('Assistant setup is not enabled on this environment.', 404) };
    if (!current?.cloudflare_account_id) return { error: fail('Connect GitHub and Cloudflare first.', 401) };
    if (!isLaunchId(id)) return { error: fail('Open assistant setup from a live site in your toolkit.', 404) };
    const job = await getOwnedJob(env, current, id, now());
    if (!job || job.status !== 'live' || !job.repository_id)
      return { error: fail('Assistant setup is available after a live, verified launch.', 404) };
    return { job };
  }

  async function page(env, current, request) {
    const id = new URL(request.url).searchParams.get('id');
    const loaded = await loadLiveJob(env, current, id);
    if (loaded.error) return loaded.error;
    const { job } = loaded;
    const store = createAssistantBootstrapStore(env, current);
    let state = await store.read(job.id);
    const websiteRepo = websiteRepoForJob(job);
    const back = '<p><a href="/toolkit">Back to toolkit</a></p>';

    if (!state) {
      return view('Set up private assistant',
        progress('consent') +
        '<h2>Set up your private website assistant</h2>' +
        '<p class="pill">Owner / invite beta · not public GA</p>' +
        consentMarkup({
          owner: job.github_login, siteSlug: job.site_slug, websiteRepo,
          workersPlan: 'free'
        }) +
        '<form action="/assistant-setup/consent" method="POST">' +
        '<input type="hidden" name="csrf" value="' + escape(current.csrf) + '">' +
        '<input type="hidden" name="id" value="' + escape(job.id) + '">' +
        '<label><input type="checkbox" name="consent_create" value="1" required> I understand what will be created and that I pay any provider charges on my account</label><br>' +
        '<label><input type="checkbox" name="consent_merge" value="1" required> I will review and merge every change myself</label><br>' +
        '<p class="tk-actions"><button type="submit">Continue</button></p></form>' + back);
    }

    if (state.step === 'consent' || state.step === 'cf_grant') {
      const granted = Number(current.cloudflare_assistant_grant) === 1;
      if (!granted) {
        return view('Allow assistant setup',
          progress('cf_grant') +
          '<h2>Allow assistant setup in Cloudflare</h2>' +
          '<p>This asks Cloudflare for a one-time grant to create a Worker and D1 in <strong>your</strong> account. It is not added to ordinary sign-in.</p>' +
          '<p class="tk-actions"><a class="btn" href="/connect/cloudflare?purpose=assistant">Allow assistant setup in Cloudflare</a></p>' +
          '<p class="muted">After Cloudflare confirms, reopen this page from your toolkit.</p>' + back);
      }
      await store.advance(job.id, { step: 'cf_grant' });
      return view('Create assistant resources',
        progress('create') +
        '<h2>Create resources in your accounts</h2>' +
        '<p>Next, Launch &amp; Own will create the private assistant repo, D1 database and bootstrap Worker in your accounts. Secrets stay in your Worker — not in Launch &amp; Own.</p>' +
        button('/assistant-setup/create', 'Create resources', current.csrf,
          '<input type="hidden" name="id" value="' + escape(job.id) + '">') + back);
    }

    if (state.step === 'create') {
      return view('Create assistant resources',
        progress('create') +
        '<h2>Create resources in your accounts</h2>' +
        (state.errorCode ? '<p role="status">Last attempt failed (<code>' + escape(state.errorCode) + '</code>). You can retry.</p>' : '') +
        button('/assistant-setup/create', 'Create resources', current.csrf,
          '<input type="hidden" name="id" value="' + escape(job.id) + '">') + back);
    }

    if (state.step === 'access') {
      return view('Configure Access',
        progress('access') +
        '<h2>Cloudflare Access</h2>' +
        accessGuideMarkup({ siteSlug: job.site_slug, origin: state.workerOrigin }) +
        '<form action="/assistant-setup/access" method="POST">' +
        '<input type="hidden" name="csrf" value="' + escape(current.csrf) + '">' +
        '<input type="hidden" name="id" value="' + escape(job.id) + '">' +
        '<p><label>Team domain<br><input name="team_domain" required placeholder="yourteam.cloudflareaccess.com" autocomplete="off"></label></p>' +
        '<p><label>Application AUD<br><input name="aud" required autocomplete="off"></label></p>' +
        '<p><label>Your Access sub<br><input name="owner_sub" required autocomplete="off"></label></p>' +
        '<p class="tk-actions"><button type="submit">Save Access settings</button></p></form>' + back);
    }

    if (state.step === 'github_app') {
      const appSlug = job.site_slug + '-assistant';
      return view('Create GitHub App',
        progress('github_app') +
        '<h2>Private GitHub App</h2>' +
        '<p>Create a GitHub App named <code>' + escape(appSlug) + '</code> with Contents: write, Pull requests: write, Metadata: read. No webhooks. Paste the App id and private key — they go straight into <strong>your</strong> Worker secrets, never into Launch &amp; Own storage.</p>' +
        '<p>Or finish later with <code>node assistant/setup/manifest-exchange.mjs</code> from your assistant repo.</p>' +
        '<form action="/assistant-setup/github-app" method="POST">' +
        '<input type="hidden" name="csrf" value="' + escape(current.csrf) + '">' +
        '<input type="hidden" name="id" value="' + escape(job.id) + '">' +
        '<p><label>GitHub App id<br><input name="app_id" required pattern="[0-9]+" inputmode="numeric" autocomplete="off"></label></p>' +
        '<p><label>Private key (PEM)<br><textarea name="private_key" required rows="8" autocomplete="off"></textarea></label></p>' +
        '<p class="tk-actions"><button type="submit">Save App credentials</button></p></form>' + back);
    }

    if (state.step === 'install') {
      const appSlug = job.site_slug + '-assistant';
      return view('Install GitHub App',
        progress('install') +
        '<h2>Install on your website repo only</h2>' +
        installGuideMarkup({ appSlug, websiteRepo }) +
        '<form action="/assistant-setup/install" method="POST">' +
        '<input type="hidden" name="csrf" value="' + escape(current.csrf) + '">' +
        '<input type="hidden" name="id" value="' + escape(job.id) + '">' +
        '<p><label>Installation id<br><input name="installation_id" required pattern="[0-9]+" inputmode="numeric" autocomplete="off"></label></p>' +
        '<p><label>Website repository id<br><input name="repo_id" required pattern="[0-9]+" value="' +
        escape(String(job.repository_id)) + '" inputmode="numeric" autocomplete="off"></label></p>' +
        '<p class="tk-actions"><button type="submit">Finish setup</button></p></form>' + back);
    }

    if (state.step === 'ready') {
      return view('Assistant ready',
        progress('ready') +
        '<h2>Your assistant is ready</h2>' +
        '<p>Open it in your browser. Launch &amp; Own does not proxy this UI.</p>' +
        '<p class="tk-actions"><a class="btn" href="' + escape(state.workerOrigin) + '" rel="noopener">Open your assistant</a></p>' +
        '<p>Private repo: <code>' + escape(state.assistantRepo || '') + '</code></p>' + back);
    }

    return view('Assistant setup',
      progress(state.step) +
      '<p>Setup status: <code>' + escape(state.step) + '</code>' +
      (state.errorCode ? ' · <code>' + escape(state.errorCode) + '</code>' : '') + '</p>' + back);
  }

  async function consent(request, env, current) {
    const form = await formData(request);
    assertCsrf(request, form, current, env.ONBOARDING_ORIGIN);
    const id = form.get('id');
    const loaded = await loadLiveJob(env, current, id);
    if (loaded.error) return loaded.error;
    if (form.get('consent_create') !== '1' || form.get('consent_merge') !== '1')
      return fail('Confirm both consent boxes to continue.');
    const store = createAssistantBootstrapStore(env, current);
    const existing = await store.read(loaded.job.id);
    if (!existing) {
      await store.start({
        jobId: loaded.job.id,
        siteSlug: loaded.job.site_slug,
        runId: crypto.randomUUID(),
        upstreamSha: upstreamSha(env)
      });
      await store.advance(loaded.job.id, { step: 'cf_grant' });
    }
    return redirect('/assistant-setup?id=' + encodeURIComponent(loaded.job.id));
  }

  async function create(request, env, current) {
    const form = await formData(request);
    assertCsrf(request, form, current, env.ONBOARDING_ORIGIN);
    const id = form.get('id');
    const loaded = await loadLiveJob(env, current, id);
    if (loaded.error) return loaded.error;
    if (Number(current.cloudflare_assistant_grant) !== 1)
      return fail('Allow assistant setup in Cloudflare first.', 403);
    const store = createAssistantBootstrapStore(env, current);
    const state = await store.read(loaded.job.id);
    if (!state || (state.step !== 'cf_grant' && state.step !== 'create'))
      return fail('Open assistant setup and continue from the current step.');
    await store.advance(loaded.job.id, { step: 'create' });
    try {
      const [cfToken, ghToken] = await Promise.all([
        getFreshAccessToken({ env, session: current, provider: 'cloudflare' }),
        getFreshAccessToken({ env, session: current, provider: 'github' })
      ]);
      const result = await createAssistantResources({
        siteSlug: loaded.job.site_slug,
        ownerLogin: loaded.job.github_login,
        websiteRepo: websiteRepoForJob(loaded.job),
        upstreamSha: state.upstreamSha || upstreamSha(env),
        accountId: current.cloudflare_account_id,
        cloudflareToken: cfToken,
        githubToken: ghToken
      });
      await store.advance(loaded.job.id, {
        step: 'access',
        assistantRepo: result.assistantRepo,
        workerName: result.workerName,
        d1Id: result.d1Id,
        workerOrigin: result.workerOrigin,
        createdThisRun: result.createdThisRun
      });
    } catch (error) {
      const code = String(error?.message || 'create_failed').slice(0, 80);
      console.error(JSON.stringify({ event: 'assistant_bootstrap_create_failed', code }));
      await store.advance(loaded.job.id, { step: 'create', errorCode: code });
      return fail('Could not create assistant resources (' + code + '). Fix the issue and retry.');
    }
    return redirect('/assistant-setup?id=' + encodeURIComponent(loaded.job.id));
  }

  async function access(request, env, current) {
    const form = await formData(request);
    assertCsrf(request, form, current, env.ONBOARDING_ORIGIN);
    const id = form.get('id');
    const loaded = await loadLiveJob(env, current, id);
    if (loaded.error) return loaded.error;
    if (Number(current.cloudflare_assistant_grant) !== 1)
      return fail('Allow assistant setup in Cloudflare first.', 403);
    const store = createAssistantBootstrapStore(env, current);
    const state = await store.read(loaded.job.id);
    if (!state || state.step !== 'access' || !state.workerName || !state.d1Id || !state.workerOrigin)
      return fail('Create assistant resources before configuring Access.');
    const teamDomain = String(form.get('team_domain') || '').trim();
    const aud = String(form.get('aud') || '').trim();
    const ownerSub = String(form.get('owner_sub') || '').trim();
    if (!teamDomain || !aud || !ownerSub) return fail('Team domain, AUD and Access sub are required.');
    try {
      const cfToken = await getFreshAccessToken({ env, session: current, provider: 'cloudflare' });
      await applyAccessVars({
        accountId: current.cloudflare_account_id,
        workerName: state.workerName,
        d1Id: state.d1Id,
        cloudflareToken: cfToken,
        teamDomain, aud, ownerSub,
        origin: state.workerOrigin,
        upstreamSha: state.upstreamSha,
        websiteRepo: websiteRepoForJob(loaded.job)
      });
      await store.advance(loaded.job.id, { step: 'github_app' });
    } catch (error) {
      const code = String(error?.message || 'access_failed').slice(0, 80);
      console.error(JSON.stringify({ event: 'assistant_bootstrap_access_failed', code }));
      return fail('Could not save Access settings (' + code + ').');
    }
    return redirect('/assistant-setup?id=' + encodeURIComponent(loaded.job.id));
  }

  async function githubApp(request, env, current) {
    // PEM may exceed the default 4 KiB form cap used elsewhere.
    if (!/^application\/x-www-form-urlencoded(?:;|$)/i.test(request.headers.get('content-type') || ''))
      return fail('Unsupported form submission.');
    const len = Number(request.headers.get('content-length') || 0);
    if (len > 16_384) return fail('Form submission is too large.');
    const { readBounded } = await import('./website-zip.mjs');
    const bytes = await readBounded(request.body, 16_384);
    if (!bytes) return fail('Form submission is too large.');
    const form = new URLSearchParams(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    assertCsrf(request, form, current, env.ONBOARDING_ORIGIN);
    const id = form.get('id');
    const loaded = await loadLiveJob(env, current, id);
    if (loaded.error) return loaded.error;
    if (Number(current.cloudflare_assistant_grant) !== 1)
      return fail('Allow assistant setup in Cloudflare first.', 403);
    const store = createAssistantBootstrapStore(env, current);
    const state = await store.read(loaded.job.id);
    if (!state || state.step !== 'github_app' || !state.workerName)
      return fail('Configure Access before the GitHub App step.');
    const appId = String(form.get('app_id') || '').trim();
    const privateKey = String(form.get('private_key') || '').trim();
    if (!/^\d+$/.test(appId) || !privateKey.includes('BEGIN'))
      return fail('App id and PEM private key are required.');
    try {
      const cfToken = await getFreshAccessToken({ env, session: current, provider: 'cloudflare' });
      await putGithubAppPrivateKey({
        accountId: current.cloudflare_account_id,
        workerName: state.workerName,
        cloudflareToken: cfToken,
        privateKeyPem: privateKey
      });
      // Stash app id on Worker via install step redeploy; keep a short-lived note in memory only via form.
      // Advance with app id embedded in createdThisRun metadata (non-secret).
      const meta = [...(state.createdThisRun || []), { id: 'gh_app_id', name: appId }];
      await store.advance(loaded.job.id, { step: 'install', createdThisRun: meta });
    } catch (error) {
      const code = String(error?.message || 'github_app_failed').slice(0, 80);
      console.error(JSON.stringify({ event: 'assistant_bootstrap_github_app_failed', code }));
      return fail('Could not save the GitHub App key (' + code + ').');
    }
    return redirect('/assistant-setup?id=' + encodeURIComponent(loaded.job.id));
  }

  async function install(request, env, current) {
    const form = await formData(request);
    assertCsrf(request, form, current, env.ONBOARDING_ORIGIN);
    const id = form.get('id');
    const loaded = await loadLiveJob(env, current, id);
    if (loaded.error) return loaded.error;
    if (Number(current.cloudflare_assistant_grant) !== 1)
      return fail('Allow assistant setup in Cloudflare first.', 403);
    const store = createAssistantBootstrapStore(env, current);
    const state = await store.read(loaded.job.id);
    if (!state || state.step !== 'install' || !state.workerName || !state.d1Id)
      return fail('Save the GitHub App before installing it.');
    const installationId = String(form.get('installation_id') || '').trim();
    const repoId = String(form.get('repo_id') || '').trim();
    const appId = String((state.createdThisRun || []).find(x => x.id === 'gh_app_id')?.name || '').trim();
    if (!/^\d+$/.test(installationId) || !/^\d+$/.test(repoId) || !/^\d+$/.test(appId))
      return fail('Installation id, repository id and App id are required.');
    try {
      const cfToken = await getFreshAccessToken({ env, session: current, provider: 'cloudflare' });
      await applyGithubInstall({
        accountId: current.cloudflare_account_id,
        workerName: state.workerName,
        d1Id: state.d1Id,
        cloudflareToken: cfToken,
        installationId, repoId, appId,
        origin: state.workerOrigin,
        upstreamSha: state.upstreamSha,
        websiteRepo: websiteRepoForJob(loaded.job)
      });
      await store.advance(loaded.job.id, { step: 'ready' });
    } catch (error) {
      const code = String(error?.message || 'install_failed').slice(0, 80);
      console.error(JSON.stringify({ event: 'assistant_bootstrap_install_failed', code }));
      return fail('Could not finish GitHub App install (' + code + ').');
    }
    return redirect('/assistant-setup?id=' + encodeURIComponent(loaded.job.id));
  }

  return Object.freeze({ page, consent, create, access, githubApp, install });
}

export function toolkitAssistantCta({ jobId, verified, env, escape }) {
  if (!assistantBootstrapEnabled(env) || !verified || !isLaunchId(jobId)) return '';
  return '<p class="tk-actions"><a class="btn-secondary btn" href="/assistant-setup?id=' +
    encodeURIComponent(jobId) + '">Set up private assistant</a></p>' +
    '<p class="muted">Owner / invite beta. Creates resources in your accounts; no wrangler.</p>';
}
