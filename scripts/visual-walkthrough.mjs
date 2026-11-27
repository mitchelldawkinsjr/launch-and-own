#!/usr/bin/env node
/**
 * Playwright visual review of every onboarding screen, driven through the real local mock server
 * (scripts/serve-onboarding-mock.mjs: mocked GitHub/Cloudflare, no live accounts, no customer data).
 * Screens are reached the way an owner reaches them (clicks, forms, a ZIP upload), then every
 * same-origin link from those screens is followed so nothing reachable is missed.
 *
 * Output (gitignored): visual-walkthrough/index.html — screenshots at 3 widths, plus a consistency
 * table that flags screens whose fonts, buttons, widths or page frame differ from the rest.
 *
 *   npm run visual:walkthrough            # all screens
 *   npm run visual:walkthrough -- --open  # and open the gallery
 */
import {execFileSync} from 'node:child_process';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import {startMockServer} from './serve-onboarding-mock.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'visual-walkthrough');
const VIEWPORTS = [{id: 'mobile', width: 375, height: 812}, {id: 'tablet', width: 768, height: 1024}, {id: 'desktop', width: 1440, height: 900}];
// Never followed by the crawler: they sign out, leave the site, or are not owner screens.
const SKIP = /^\/(logout|_open|connect\/|oauth\/|dev\/|internal\/|health|logo\.png|site-editor\/)/;
// Query values that pick a different screen are kept; ids and tickets are not.
const KEEP = new Set(['path', 'page', 'view', 'tab']);

const slug = text => String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
export function screenKey(url) {
  const u = new URL(url);
  const query = [...u.searchParams.keys()].sort().map(k => KEEP.has(k) ? k + '=' + u.searchParams.get(k) : k).join('&');
  return u.pathname + (query ? '?' + query : '');
}

/** Design values that should match across screens. Runs in the page at desktop width. */
function tokens() {
  const css = (el, prop) => el ? getComputedStyle(el)[prop] : '—';
  const visible = el => el && el.getBoundingClientRect().width > 0 && getComputedStyle(el).visibility !== 'hidden';
  const h1 = document.querySelector('h1');
  // The primary button (filled), so secondary buttons don't hide the house style.
  const button = [...document.querySelectorAll('main button, main .btn, button, .btn')].filter(visible)
    .find(el => !/^rgba?\(255, 255, 255|rgba\(0, 0, 0, 0\)/.test(getComputedStyle(el).backgroundColor));
  const link = [...document.querySelectorAll('main p a, p a')].find(visible);
  const frame = document.querySelector('main') || document.body.firstElementChild || document.body;
  return {
    'Body font': css(document.body, 'fontFamily').split(',')[0].replace(/"/g, ''),
    'Body size': css(document.body, 'fontSize'),
    'Page background': css(document.body, 'backgroundColor'),
    'Content width': Math.round(frame.getBoundingClientRect().width) + 'px',
    'H1 size': css(h1, 'fontSize'),
    'H1 weight': css(h1, 'fontWeight'),
    'Button background': css(button, 'backgroundColor'),
    'Button radius': css(button, 'borderRadius'),
    'Button size': css(button, 'fontSize'),
    'Link color': css(link, 'color'),
    'Brand header': document.querySelector('header img, header .brand, .brand, [class*=brand] img') ? 'yes' : 'no',
    'Footer': document.querySelector('footer') ? 'yes' : 'no',
    'Step indicator': document.querySelector('[class*=step], ol[aria-label]') ? 'yes' : 'no'
  };
}

/** Measurable design-law checks (.claude/skills/design-laws). Runs in the page at desktop width. */
function lawChecks() {
  const flags = [];
  const visible = el => el.getBoundingClientRect().width > 0 && getComputedStyle(el).visibility !== 'hidden';
  const main = document.querySelector('main') || document.body;
  const primary = [...main.querySelectorAll('button, .btn')].filter(visible).filter(el => {
    const bg = getComputedStyle(el).backgroundColor;
    return !/^rgba?\(255, 255, 255|rgba\(0, 0, 0, 0\)|transparent/.test(bg);
  });
  if (primary.length > 1) flags.push('Von Restorff: ' + primary.length + ' primary buttons (' + primary.slice(0, 3).map(b => b.textContent.trim().slice(0, 30)).join(' / ') + ')');
  const text = main.innerText || '';
  const hashes = text.match(/\b[a-f0-9]{40}\b/g) || [];
  if (hashes.length) flags.push("Tesler: " + hashes.length + ' raw version code(s) on screen');
  const words = text.split(/\s+/).filter(Boolean).length;
  if (words > 450) flags.push('Cognitive load: ' + words + ' words visible');
  return flags;
}

async function main() {
  const wantOpen = process.argv.includes('--open');
  await rm(outDir, {recursive: true, force: true});
  await mkdir(join(outDir, 'shots'), {recursive: true});
  // Two servers, one after the other (each installs its own mocked global fetch): a fresh one for the
  // new-owner journey, then one seeded with a live uploaded site for its editor.
  let server = await startMockServer({port: 0, zip: true});
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch();
  const screens = [], seen = new Set(), problems = [];

  async function capture(page, title, phase, notes = '', {ownUi = true} = {}) {
    await page.waitForLoadState('networkidle').catch(() => {});
    const id = String(screens.length + 1).padStart(2, '0') + '-' + slug(title);
    seen.add(screenKey(page.url()));
    const shots = [];
    for (const vp of VIEWPORTS) {
      await page.setViewportSize({width: vp.width, height: vp.height});
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(150);
      const file = 'shots/' + id + '-' + vp.id + '.png';
      await page.screenshot({path: join(outDir, file), fullPage: true});
      shots.push({viewport: vp.id, width: vp.width, file, ...await page.evaluate(() => ({
        height: document.documentElement.scrollHeight, overflow: document.documentElement.scrollWidth > window.innerWidth + 1}))});
    }
    const axe = await new AxeBuilder({page}).analyze()
      .then(r => r.violations.map(v => v.id + ' ×' + v.nodes.length)).catch(() => ['axe could not run']);
    const u = new URL(page.url());
    screens.push({id, title, phase, notes, ownUi, url: u.pathname + u.search.replace(/(ticket|id|challenge_id)=[^&]+/g, '$1=…'),
      status: page.__status ?? 200, shots, tokens: await page.evaluate(tokens), laws: ownUi ? await page.evaluate(lawChecks) : [], axe, console: page.__errors.splice(0)});
    console.log('  ' + id + '  ' + u.pathname);
  }
  async function newPage() {
    const context = await browser.newContext({viewport: {width: 1440, height: 900}});
    const page = await context.newPage();
    page.__errors = [];
    page.on('console', m => { if (m.type() === 'error') page.__errors.push(m.text().slice(0, 200)); });
    page.on('response', r => { if (r.request().isNavigationRequest() && r.frame() === page.mainFrame()) page.__status = r.status(); });
    return page;
  }
  async function step(name, fn) {
    try { await fn(); } catch (error) {
      const why = String(error?.message || error).split('\n')[0];
      problems.push(name + ': ' + why);
      console.log('  ! ' + name + ': ' + why);
    }
  }

  // Follow every same-origin link from a signed-in session so nothing reachable is missed.
  async function crawl(page, origin) {
    const queue = [origin + '/', origin + '/history', origin + '/toolkit', page.url()];
    for (let guard = 0; queue.length && guard < 80; guard++) {
      const url = queue.shift();
      await step('crawl ' + new URL(url).pathname, async () => {
        await page.goto(url);
        for (const link of await page.$$eval('a[href]', as => as.map(a => a.href))) {
          const u = new URL(link);
          u.hash = '';
          if (u.origin !== origin || SKIP.test(u.pathname)) continue;
          if (!seen.has(screenKey(u.href)) && !queue.some(q => screenKey(q) === screenKey(u.href))) queue.push(u.href);
        }
        if (!seen.has(screenKey(page.url()))) {
          const h1 = await page.locator('h1').first().textContent({timeout: 500}).catch(() => null);
          await capture(page, (h1 || new URL(page.url()).pathname).trim().slice(0, 60), 'Found by link');
        }
      });
    }
  }

  try {
    // 1. Signed out.
    const out = await newPage();
    for (const [path, title, phase] of [['/', 'Landing (signed out)', 'Start'], ['/privacy', 'Privacy policy', 'Legal'], ['/terms', 'Terms', 'Legal'],
      ['/toolkit', 'Toolkit (signed out)', 'Start'], ['/not-a-page', 'Not found', 'Errors']])
      await step(title, async () => { await out.goto(base + path); await capture(out, title, phase); });

    // 2. A new owner: connect, create, approve, own.
    const owner = await newPage();
    let jobId = null;
    await step('connect', async () => {
      await owner.goto(base + '/');
      await owner.getByRole('link', {name: 'Connect GitHub'}).first().click();
      await capture(owner, 'GitHub connected', 'Connect');
      await owner.getByRole('link', {name: 'Connect Cloudflare'}).first().click();
      await capture(owner, 'Choose Cloudflare account', 'Connect');
      await owner.getByLabel('Cloudflare account').selectOption({index: 0});
      await owner.getByRole('button', {name: 'Use this account'}).click();
      await capture(owner, 'Setup home (ready to create)', 'Create');
    });
    await step('create', async () => {
      const create = owner.locator('form[action="/preview"]');
      await create.getByLabel('Business or website name').fill('Willow Studio');
      await create.getByLabel('Homepage headline').fill('Portraits with care');
      await create.getByLabel('Describe your business').fill('Family portraits and community events in town.');
      await owner.getByRole('button', {name: 'Preview my website'}).click();
      await capture(owner, 'Review and approve new site', 'Create');
      const reviewUrl = owner.url();
      jobId = new URL(reviewUrl).searchParams.get('id');
      const preview = await owner.getByRole('link', {name: 'Open the exact preview'}).getAttribute('href');
      await owner.goto(new URL(preview, base).href);
      await capture(owner, 'Exact site preview', 'Create', 'The customer\'s generated site, not Launch & Own UI: left out of the consistency table.', {ownUi: false});
      await owner.goto(reviewUrl);
      await owner.getByRole('button', {name: 'Approve and create website'}).click();
      await capture(owner, 'After approval', 'Launch');
      for (const [label, title] of [['Continue launch', 'Launch in progress'], ['Check if it is live', 'Launch: checking it is live']]) {
        const next = owner.getByRole('button', {name: label});
        if (await next.count()) { await next.first().click(); await capture(owner, title, 'Launch'); }
      }
    });
    await step('history', async () => { await owner.goto(base + '/history'); await capture(owner, 'Your launches', 'Own'); });
    await step('toolkit', async () => {
      await owner.goto(base + '/toolkit');
      await capture(owner, 'Toolkit: overview', 'Own');
      const tabs = owner.getByRole('radio');
      const count = await tabs.count();
      for (let i = 1; i < count; i++) {
        const name = (await tabs.nth(i).getAttribute('aria-label')) || ('tab ' + i);
        await tabs.nth(i).check({force: true});
        await capture(owner, 'Toolkit: ' + name, 'Own', 'Same address as the overview, different tab.');
      }
    });
    await step('site update', async () => {
      await owner.goto(base + '/site-update?id=' + jobId);
      await capture(owner, 'Update a created site', 'Update');
      await owner.getByLabel(/headline|tagline/i).first().fill('Portraits and events, with care');
      await owner.getByRole('button', {name: /preview/i}).first().click();
      await capture(owner, 'Review site update', 'Update');
      await owner.getByRole('button', {name: 'Approve and publish'}).click();
      await capture(owner, 'Site update status', 'Update');
    });
    await step('optional features', async () => {
      await owner.goto(base + '/site-options?id=' + jobId);
      await capture(owner, 'Optional features (created site)', 'Grow');
    });

    // 3. An uploaded (ZIP) site: upload and import report.
    await step('zip upload', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'lo-visual-'));
      const zip = join(dir, 'site.zip');
      execFileSync('zip', ['-qr', zip, '.'], {cwd: join(root, 'fixtures/imported-sites/static-multipage/public')});
      try {
        await owner.goto(base + '/');
        await owner.locator('#zip-name').fill('Example Bakery');
        await owner.locator('#website-zip').setInputFiles(zip);
        await owner.getByRole('button', {name: 'Upload and preview'}).click();
        await capture(owner, 'Uploaded site: import report', 'Bring');
      } finally { await rm(dir, {recursive: true, force: true}); }
    });

    await crawl(owner, base);
    server.close();

    // 4. Editing an uploaded site that is already live (seeded).
    server = await startMockServer({port: 0, editorFixture: true});
    const editorBase = 'http://127.0.0.1:' + server.address().port;
    const editor = await newPage();
    await step('imported editor', async () => {
      await editor.goto(editorBase + '/dev/open-editor');
      await capture(editor, 'Edit uploaded site (visual editor)', 'Update');
    });
    await step('imported edit', async () => {
      const editorUrl = editor.url();
      await editor.locator('.ve-fallback').evaluate(d => { d.open = true; });
      await editor.locator('.ve-fallback ul a', {hasText: 'Saturday'}).first().click();
      await editor.locator('.ve-fallback').evaluate(d => { d.open = true; });
      await capture(editor, 'Uploaded-site editor: spot picked', 'Update');
      await editor.locator('#ve-replace').fill('Saturday: 8 AM-3 PM');
      await editor.getByRole('button', {name: 'Preview this change'}).click();
      await capture(editor, 'Review uploaded-site edit', 'Update');
      await editor.getByRole('button', {name: 'Approve and publish'}).click();
      await capture(editor, 'Uploaded-site edit status', 'Update');
      const id = new URL(editorUrl).searchParams.get('id');
      await editor.goto(editorBase + '/form-messages?id=' + id);
      await capture(editor, 'Form messages inbox', 'Grow');
    });
    await crawl(editor, editorBase);
  } finally {
    await browser.close();
    server.close();
  }

  const report = {generatedAt: new Date().toISOString(), screens, problems, consistency: consistency(screens)};
  await writeFile(join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(join(outDir, 'index.html'), galleryHtml(report));
  console.log('\n' + screens.length + ' screens · ' + report.consistency.outliers + ' consistency outliers · ' +
    screens.filter(s => s.axe.length).length + ' with accessibility issues · ' +
    screens.filter(s => s.laws.length).length + ' with design-law flags · ' + problems.length + ' steps not reached');
  console.log('Gallery: ' + join(outDir, 'index.html'));
  if (wantOpen) execFileSync('open', [join(outDir, 'index.html')]);
}

/** For each design value, the most common answer is the house style; every other screen is flagged. */
export function consistency(screens) {
  const names = screens.length ? Object.keys(screens[0].tokens) : [];
  let outliers = 0;
  const rows = names.map(name => {
    // Only our own screens that have the element are compared (a page with no button is not off-style).
    const compared = screens.filter(s => s.ownUi !== false && s.tokens[name] !== '—');
    const counts = new Map();
    for (const s of compared) counts.set(s.tokens[name], (counts.get(s.tokens[name]) || 0) + 1);
    const house = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '—';
    const odd = compared.filter(s => s.tokens[name] !== house).map(s => s.id);
    outliers += odd.length;
    return {name, house, variants: counts.size, odd};
  });
  return {rows, outliers};
}

function galleryHtml(report) {
  const esc = s => String(s).replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'})[c]);
  const byId = new Map(report.screens.map(s => [s.id, s]));
  const table = '<table><thead><tr><th>Design value</th><th>House style (most screens)</th><th>Screens that differ</th></tr></thead><tbody>' +
    report.consistency.rows.map(r => `<tr class="${r.odd.length ? 'bad' : ''}"><th>${esc(r.name)}</th><td><code>${esc(r.house)}</code></td><td>${
      r.odd.length ? r.odd.map(id => `<a href="#${esc(id)}">${esc(byId.get(id).title)}</a> <code>${esc(byId.get(id).tokens[r.name])}</code>`).join('<br>') : '✓ all match'}</td></tr>`).join('') + '</tbody></table>';
  const nav = report.screens.map(s => `<a href="#${esc(s.id)}">${esc(s.id.slice(0, 2))} ${esc(s.title)}</a>`).join('');
  const cards = report.screens.map(s => {
    const flags = [
      ...report.consistency.rows.filter(r => r.odd.includes(s.id)).map(r => `<span class="flag">differs: ${esc(r.name)}</span>`),
      ...s.axe.map(a => `<span class="flag a11y">a11y: ${esc(a)}</span>`),
      ...s.shots.filter(v => v.overflow).map(v => `<span class="flag">sideways scroll at ${v.width}px</span>`),
      ...s.console.map(c => `<span class="flag">console: ${esc(c)}</span>`),
      ...(s.laws || []).map(l => `<span class="flag law">${esc(l)}</span>`),
      ...(s.status >= 400 ? [`<span class="flag">HTTP ${s.status}</span>`] : [])
    ].join('');
    return `<section class="card" id="${esc(s.id)}"><header><p class="phase">${esc(s.phase)} · <code>${esc(s.url)}</code></p><h2>${esc(s.id.slice(0, 2))} · ${esc(s.title)}</h2>` +
      (s.notes ? `<p class="notes">${esc(s.notes)}</p>` : '') + `<div class="flags">${flags || '<span class="ok">matches house style · no axe issues</span>'}</div></header>` +
      `<div class="shots">${s.shots.map(v => `<figure><a href="${esc(v.file)}" target="_blank"><img src="${esc(v.file)}" alt="${esc(s.title)} at ${v.width}px" loading="lazy"></a><figcaption>${esc(v.viewport)} · ${v.width}px · ${v.height}px tall</figcaption></figure>`).join('')}</div></section>`;
  }).join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Launch &amp; Own · screen review</title><style>
:root{--bg:#f3f5f9;--ink:#14213a;--muted:#5b677c;--panel:#fff;--rule:#d7deea;--bad:#b42318;--badbg:#fef3f2}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,sans-serif;background:var(--bg);color:var(--ink)}
.layout{display:grid;grid-template-columns:260px 1fr;gap:24px;max-width:1500px;margin:0 auto;padding:24px}
nav{position:sticky;top:16px;align-self:start;max-height:calc(100vh - 32px);overflow:auto;display:flex;flex-direction:column;gap:2px;font-size:13px}
nav a{color:var(--ink);text-decoration:none;padding:4px 8px;border-radius:6px}nav a:hover{background:var(--panel)}
h1{margin:0 0 6px}.lede,.notes,.phase{color:var(--muted)}.phase{font-size:12px;margin:0}
table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--rule);margin:16px 0 28px;font-size:13px}
th,td{text-align:left;vertical-align:top;padding:8px 10px;border-top:1px solid var(--rule)}thead th{background:#e9eef6}
tr.bad td:last-child{background:var(--badbg)}td a{color:var(--bad)}
.card{background:var(--panel);border:1px solid var(--rule);border-radius:14px;padding:16px;margin:0 0 20px;scroll-margin-top:16px}
.card h2{margin:4px 0}.flags{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.flag{background:var(--badbg);color:var(--bad);border-radius:999px;padding:3px 9px;font-size:12px}.flag.a11y{background:#fffaeb;color:#93370d}.flag.law{background:#f4f3ff;color:#5925dc}.ok{color:#067647;font-size:12px}
.shots{display:grid;gap:12px;grid-template-columns:1fr 1.6fr 3fr;margin-top:12px;align-items:start}
figure{margin:0}img{width:100%;border:1px solid var(--rule);border-radius:8px;background:#fff}figcaption{font-size:12px;color:var(--muted)}
@media(max-width:900px){.layout{grid-template-columns:1fr}nav{position:static;max-height:none}.shots{grid-template-columns:1fr}}
</style></head><body><div class="layout"><nav aria-label="Screens"><strong>Screens</strong>${nav}</nav><main>
<h1>Screen review</h1><p class="lede">${report.screens.length} onboarding screens through the local mock server (mocked providers, no live accounts). Generated ${esc(report.generatedAt)}.</p>
<h2>Consistency</h2><p class="lede">The most common value is treated as the house style. Red rows list the screens that break it.</p>${table}
${report.problems.length ? '<h2>Not reached</h2><ul>' + report.problems.map(p => '<li>' + esc(p) + '</li>').join('') + '</ul>' : ''}
${cards}</main></div></body></html>`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error); process.exitCode = 1; });
