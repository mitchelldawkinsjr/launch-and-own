#!/usr/bin/env node
/**
 * Local Playwright visual walkthrough of Launch & Own onboarding screens.
 * Uses the existing Worker test harness (mocked providers) so no live OAuth
 * or customer data is required. Writes screenshots + layout stats + a gallery.
 *
 *   npm run visual:walkthrough
 *   npm run visual:walkthrough -- --open
 */
import {mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {chromium} from 'playwright';
import {
  approvePreview, connectTenant, harness, makeDue, newPreview, originalFetch, post
} from '../onboarding/worker-test-support.mjs';
import {writeLocalPreview} from './export-preview.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'visual-walkthrough');
const shotsDir = join(outDir, 'shots');
const VIEWPORTS = Object.freeze([
  {id: 'mobile', width: 375, height: 812},
  {id: 'tablet', width: 768, height: 1024},
  {id: 'desktop', width: 1440, height: 900}
]);

function slug(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

async function collectStats(page) {
  return page.evaluate(() => {
    const body = document.body;
    const main = document.querySelector('main') || body;
    const style = getComputedStyle(body);
    const rects = [...document.querySelectorAll('section, article, form, details')]
      .map(el => el.getBoundingClientRect().height);
    return {
      title: document.title,
      scrollHeight: Math.round(Math.max(body.scrollHeight, document.documentElement.scrollHeight)),
      clientHeight: Math.round(window.innerHeight),
      clientWidth: Math.round(window.innerWidth),
      mainWidth: Math.round(main.getBoundingClientRect().width),
      headings: document.querySelectorAll('h1,h2,h3').length,
      sections: document.querySelectorAll('section,article').length,
      links: document.querySelectorAll('a[href]').length,
      buttons: document.querySelectorAll('button, a.btn, .btn, .btn-like').length,
      inputs: document.querySelectorAll('input,textarea,select').length,
      forms: document.querySelectorAll('form').length,
      pills: document.querySelectorAll('.pill').length,
      textChars: (body.innerText || '').replace(/\s+/g, ' ').trim().length,
      bg: style.backgroundColor,
      color: style.color,
      tallestBlock: Math.round(Math.max(0, ...rects, 0))
    };
  });
}

async function captureHtml(browser, screen, html, results) {
  for (const vp of VIEWPORTS) {
    const page = await browser.newPage({viewport: {width: vp.width, height: vp.height}});
    await page.setContent(html, {waitUntil: 'load'});
    await page.evaluate(() => new Promise(r => setTimeout(r, 250)));
    const file = `${slug(screen.id)}-${vp.id}.png`;
    const path = join(shotsDir, file);
    await page.screenshot({path, fullPage: true});
    const stats = await collectStats(page);
    results.push({
      id: screen.id,
      title: screen.title,
      phase: screen.phase,
      notes: screen.notes || '',
      viewport: vp.id,
      width: vp.width,
      height: vp.height,
      file: 'shots/' + file,
      stats
    });
    await page.close();
  }
}

async function captureFile(browser, screen, filePath, results) {
  const url = pathToFileURL(filePath).href;
  for (const vp of VIEWPORTS) {
    const page = await browser.newPage({viewport: {width: vp.width, height: vp.height}});
    await page.goto(url, {waitUntil: 'networkidle'});
    await page.evaluate(() => new Promise(r => setTimeout(r, 400)));
    const file = `${slug(screen.id)}-${vp.id}.png`;
    const path = join(shotsDir, file);
    await page.screenshot({path, fullPage: true});
    const stats = await collectStats(page);
    results.push({
      id: screen.id,
      title: screen.title,
      phase: screen.phase,
      notes: screen.notes || '',
      viewport: vp.id,
      width: vp.width,
      height: vp.height,
      file: 'shots/' + file,
      stats
    });
    await page.close();
  }
}

async function buildScreens() {
  const screens = [];
  const h = harness();
  globalThis.fetch = h.fetchFn;
  try {
    const signedOut = await h.request('/');
    screens.push({
      id: '01-signed-out-home',
      title: 'Signed-out setup',
      phase: 'Connect',
      notes: 'First paint before GitHub/Cloudflare.',
      html: await signedOut.text()
    });

    const tenant = await connectTenant(h);
    const home = await h.request('/', {cookie: tenant.cookie});
    screens.push({
      id: '02-connected-home',
      title: 'Connected setup',
      phase: 'Create',
      notes: 'GitHub and Cloudflare linked; hosting account chosen; toolkit link appears.',
      html: await home.text()
    });

    const id = await newPreview(h, tenant);
    const review = await h.request('/review?id=' + id, {cookie: tenant.cookie});
    screens.push({
      id: '03-review-approve',
      title: 'Review & approve',
      phase: 'Approve',
      notes: 'Exact preview and ownership targets before anything goes live.',
      html: await review.text()
    });

    assertOk((await approvePreview(h, tenant.cookie, tenant.csrf, id)).status, 303);
    makeDue(h);
    assertOk((await post(h, '/launch', tenant.cookie, {csrf: tenant.csrf, id})).status, 303);
    makeDue(h);
    assertOk((await post(h, '/verify', tenant.cookie, {csrf: tenant.csrf, id})).status, 303);

    const history = await h.request('/history', {cookie: tenant.cookie});
    screens.push({
      id: '04-launch-history',
      title: 'Launch history',
      phase: 'Own',
      notes: '30-day launch list + update link when eligible.',
      html: await history.text()
    });

    const toolkit = await h.request('/toolkit', {cookie: tenant.cookie});
    const toolkitHtml = await toolkit.text();
    screens.push({
      id: '05-toolkit',
      title: 'Website toolkit',
      phase: 'Own',
      notes: 'Launch cards, sites found in your accounts, and what each site includes.',
      html: toolkitHtml
    });

    const ticketMatch = toolkitHtml.match(/href="(\/toolkit\/source\?ticket=[^"]+)"/);
    if (ticketMatch) {
      const source = await h.request(ticketMatch[1], {cookie: tenant.cookie});
      screens.push({
        id: '06-toolkit-source',
        title: 'Source fingerprint',
        phase: 'Own',
        notes: 'Private homepage fingerprint check only; no raw HTML shown.',
        html: await source.text()
      });
    }

    const edit = await h.request('/site-update?id=' + encodeURIComponent(id), {
      cookie: tenant.cookie
    });
    if (edit.status === 200) {
      screens.push({
        id: '07-site-update-editor',
        title: 'Safe website update editor',
        phase: 'Update',
        notes: 'Simple one-page editor; never publishes straight to the live site.',
        html: await edit.text()
      });

      const previewPost = await post(h, '/site-update-preview', tenant.cookie, {
        csrf: tenant.csrf,
        id,
        tagline: 'Updated homepage for visual walkthrough',
        about: 'Fictional portrait and community event photography.',
        services: 'Family portraits\nCommunity events',
        theme: 'forest',
        contactEmail: 'hello@willow.example'
      });
      if (previewPost.status === 303) {
        const reviewPath = previewPost.headers.get('location');
        const updateReview = await h.request(reviewPath, {cookie: tenant.cookie});
        if (updateReview.status === 200) {
          screens.push({
            id: '08-site-update-review',
            title: 'Update review & approve',
            phase: 'Update',
            notes: 'Exact preview before a GitHub change request is opened.',
            html: await updateReview.text()
          });
        }
      }
    }

    const privacy = await h.request('/privacy');
    screens.push({
      id: '09-privacy',
      title: 'Privacy policy',
      phase: 'Legal',
      notes: 'Public legal page linked from consent screens.',
      html: await privacy.text()
    });
  } finally {
    globalThis.fetch = originalFetch;
    h.sqlite.close();
  }

  const previewDir = join(outDir, 'customer-preview');
  await rm(previewDir, {recursive: true, force: true});
  await writeLocalPreview({
    site: {
      name: 'Willow Studio',
      tagline: 'Your moments, beautifully remembered',
      about: 'Fictional portrait and community event photography.',
      services: ['Family portraits', 'Community events'],
      theme: 'forest',
      contactEmail: 'hello@willow.example'
    },
    outputDir: previewDir
  });

  return {
    screens,
    files: [
      {
        id: '10-architecture',
        title: 'Architecture artifact',
        phase: 'Docs',
        notes: 'Interactive lane diagram: journey, post-launch toolkit, automation.',
        path: join(root, 'docs/architecture.html')
      },
      {
        id: '11-customer-site',
        title: 'Customer site preview',
        phase: 'Product',
        notes: 'Exported one-page Willow Studio sample (what they own).',
        path: join(previewDir, 'index.html')
      }
    ]
  };
}

function assertOk(actual, expected) {
  if (actual !== expected) throw new Error('expected ' + expected + ' got ' + actual);
}

function summarize(results) {
  const byScreen = new Map();
  for (const row of results) {
    if (!byScreen.has(row.id)) byScreen.set(row.id, []);
    byScreen.get(row.id).push(row);
  }
  const screens = [...byScreen.entries()].map(([id, rows]) => {
    const desktop = rows.find(r => r.viewport === 'desktop') || rows[0];
    return {
      id,
      title: desktop.title,
      phase: desktop.phase,
      notes: desktop.notes,
      viewports: rows.map(r => ({
        viewport: r.viewport,
        width: r.width,
        file: r.file,
        scrollHeight: r.stats.scrollHeight,
        mainWidth: r.stats.mainWidth,
        headings: r.stats.headings,
        sections: r.stats.sections,
        links: r.stats.links,
        buttons: r.stats.buttons,
        inputs: r.stats.inputs,
        textChars: r.stats.textChars
      }))
    };
  });
  const totals = {
    screens: screens.length,
    shots: results.length,
    avgDesktopHeight: Math.round(
      results.filter(r => r.viewport === 'desktop')
        .reduce((n, r) => n + r.stats.scrollHeight, 0) /
      Math.max(1, results.filter(r => r.viewport === 'desktop').length)
    ),
    densestDesktop: [...results.filter(r => r.viewport === 'desktop')]
      .sort((a, b) => b.stats.textChars - a.stats.textChars)[0]?.title || null
  };
  return {generatedAt: new Date().toISOString(), totals, screens};
}

function galleryHtml(report) {
  const esc = s => String(s).replace(/[&<>"]/g, c => (
    {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]
  ));
  const cards = report.screens.map(screen => {
    const shots = screen.viewports.map(v =>
      `<figure><img src="${esc(v.file)}" alt="${esc(screen.title)} ${esc(v.viewport)}" loading="lazy">` +
      `<figcaption><strong>${esc(v.viewport)}</strong> · ${v.width}px · scroll ${v.scrollHeight}px · ` +
      `${v.headings} headings · ${v.sections} sections · ${v.links} links · ${v.textChars} chars</figcaption></figure>`
    ).join('');
    return `<section class="card"><header><p class="phase">${esc(screen.phase)}</p>` +
      `<h2>${esc(screen.title)}</h2><p class="notes">${esc(screen.notes)}</p></header>` +
      `<div class="shots">${shots}</div></section>`;
  }).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Launch &amp; Own · visual walkthrough</title>
<style>
:root{--bg:#f3f5f9;--ink:#14213a;--muted:#5b677c;--panel:#fff;--rule:#d7deea;--accent:#1d55c4}
*{box-sizing:border-box}
body{margin:0;font:15px/1.5 system-ui,sans-serif;background:var(--bg);color:var(--ink)}
main{max-width:1200px;margin:0 auto;padding:28px 18px 64px}
h1{font-size:clamp(28px,4vw,40px);margin:0 0 8px}
.lede,.notes,.phase{color:var(--muted)}
.stats{display:flex;flex-wrap:wrap;gap:10px;margin:18px 0 28px}
.stats span{background:var(--panel);border:1px solid var(--rule);border-radius:999px;padding:8px 12px;font-size:13px}
.card{background:var(--panel);border:1px solid var(--rule);border-radius:16px;padding:18px;margin:0 0 22px}
.card h2{margin:4px 0 6px;font-size:22px}
.phase{font:600 11px/1 ui-monospace,Menlo,monospace;letter-spacing:.08em;text-transform:uppercase;margin:0}
.shots{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));margin-top:14px}
figure{margin:0}
img{width:100%;border:1px solid var(--rule);border-radius:10px;background:#fff}
figcaption{font-size:12px;color:var(--muted);margin-top:6px}
</style>
</head>
<body>
<main>
  <h1>Visual walkthrough</h1>
  <p class="lede">Harness-backed onboarding screens (mocked providers) plus architecture and customer preview. Generated ${esc(report.generatedAt)}.</p>
  <div class="stats">
    <span>${report.totals.screens} screens</span>
    <span>${report.totals.shots} screenshots</span>
    <span>avg desktop height ${report.totals.avgDesktopHeight}px</span>
    <span>densest: ${esc(report.totals.densestDesktop || '—')}</span>
  </div>
  ${cards}
</main>
</body>
</html>`;
}

async function main() {
  const wantOpen = process.argv.includes('--open');
  await rm(outDir, {recursive: true, force: true});
  await mkdir(shotsDir, {recursive: true});

  console.log('Building screen HTML via Worker harness…');
  const {screens, files} = await buildScreens();

  console.log('Launching Chromium…');
  const browser = await chromium.launch();
  const results = [];
  try {
    for (const screen of screens) {
      console.log('  capture', screen.id);
      await captureHtml(browser, screen, screen.html, results);
    }
    for (const screen of files) {
      console.log('  capture', screen.id);
      await captureFile(browser, screen, screen.path, results);
    }
  } finally {
    await browser.close();
  }

  const report = summarize(results);
  await writeFile(join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(join(outDir, 'index.html'), galleryHtml(report));
  console.log('Wrote', join(outDir, 'index.html'));
  console.log(JSON.stringify(report.totals, null, 2));

  if (wantOpen) {
    const {spawn} = await import('node:child_process');
    spawn('open', [join(outDir, 'index.html')], {detached: true, stdio: 'ignore'}).unref();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
