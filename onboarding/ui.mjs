// Launch & Own onboarding presentation layer — Stitch "Warm Self-Service Modern"
// tokens rendered as CSP-safe inline CSS (no remote fonts, scripts, or CDNs).
const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export const STEPS=[
  {id:'connect',label:'Connect',hint:'Accounts'},
  {id:'describe',label:'Describe',hint:'Your site'},
  {id:'preview',label:'Preview',hint:'Exact page'},
  {id:'approve',label:'Approve',hint:'Resources'},
  {id:'launch',label:'Launch',hint:'Verified live'}
];

export const UI_CSS=`:root{
  --bg:#FBFBF9;--card:#FFFFFF;--border:#E5E5DE;--ink:#0F172A;--muted:#434652;--subtle:#1E293B;
  --primary:#2563EB;--primary-deep:#174CA5;--primary-hover:#1D4ED8;--primary-soft:#EFF6FF;
  --ok:#059669;--ok-soft:#D1FAE5;--warn:#D97706;--warn-soft:#FEF3C7;--danger:#DC2626;--danger-soft:#FEF2F2;
  --gh-bg:#F1F5F9;--cf-bg:#FFF7ED;--cf-text:#C2410C;--orch-bg:#EFF6FF;
  --shadow:0 1px 3px rgba(15,23,42,.04),0 6px 16px -4px rgba(15,23,42,.03);
  --shadow-lg:0 4px 6px -1px rgba(15,23,42,.06),0 12px 24px -4px rgba(15,23,42,.06);
  --r:8px;--r-lg:16px;--max:780px;--max-wide:960px;
  --font:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;min-height:100vh;font:15px/1.55 var(--font);color:var(--ink);background:var(--bg);display:flex;flex-direction:column}
a{color:var(--primary);text-decoration-thickness:1px;text-underline-offset:3px}
a:hover{color:var(--primary-hover)}
a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{
  outline:2px solid var(--primary);outline-offset:2px}
.site-header{position:sticky;top:0;z-index:20;background:rgba(255,255,255,.94);backdrop-filter:blur(8px);
  border-bottom:1px solid var(--border);box-shadow:0 1px 8px rgba(0,0,0,.03)}
.site-header-inner{max-width:var(--max-wide);margin:0 auto;padding:.85rem 1rem;display:flex;align-items:center;
  justify-content:space-between;gap:1rem;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:.65rem;text-decoration:none;color:var(--ink);font-weight:700;font-size:1.05rem}
.brand img{height:32px;width:auto}
.badge{display:inline-flex;align-items:center;gap:.35rem;padding:.2rem .65rem;border-radius:999px;font-size:11px;
  font-weight:600;letter-spacing:.02em;border:1px solid transparent;line-height:1.3}
.badge-beta{background:var(--orch-bg);color:var(--primary-deep);border-color:#BFDBFE}
.badge-ok{background:var(--ok-soft);color:var(--ok)}
.badge-warn{background:var(--warn-soft);color:var(--warn)}
.badge-danger{background:var(--danger-soft);color:var(--danger)}
.badge-gh{background:var(--gh-bg);color:var(--ink);border-color:#CBD5E1}
.badge-cf{background:var(--cf-bg);color:var(--cf-text);border-color:#FFEDD5}
.badge-orch{background:var(--orch-bg);color:var(--primary-deep);border-color:#BFDBFE}
.header-meta{display:flex;align-items:center;gap:.75rem;flex-wrap:wrap;font-size:12px;color:var(--muted)}
.header-nav a{margin-left:.35rem;padding:.4rem .7rem;border-radius:var(--r);text-decoration:none;color:var(--muted);font-weight:600;font-size:13px}
.header-nav a:hover,.header-nav a[aria-current="page"]{background:var(--primary-soft);color:var(--primary-deep)}
.shell{flex:1;width:100%;max-width:var(--max-wide);margin:0 auto;padding:1.25rem 1rem 2.5rem}
.shell-narrow{max-width:var(--max)}
.stepper{margin:0 0 1.5rem;padding:1rem;background:var(--card);border:1px solid var(--border);border-radius:var(--r-lg);box-shadow:var(--shadow)}
.stepper-desktop{display:none;align-items:flex-start;justify-content:space-between;gap:.5rem;position:relative}
.stepper-desktop::before{content:"";position:absolute;left:1.25rem;right:1.25rem;top:1.15rem;height:3px;background:#E7EEFF;z-index:0}
.step{position:relative;z-index:1;flex:1;text-align:center;min-width:0}
.step-dot{width:2.25rem;height:2.25rem;margin:0 auto;border-radius:999px;display:flex;align-items:center;justify-content:center;
  font-size:13px;font-weight:700;background:var(--gh-bg);color:#64748B;border:1px solid var(--border)}
.step-label{display:block;margin-top:.45rem;font-size:13px;font-weight:600;color:#64748B}
.step-hint{display:block;font-size:11px;color:#94A3B8}
.step.is-done .step-dot{background:var(--ok);color:#fff;border-color:var(--ok)}
.step.is-done .step-label{color:var(--ok)}
.step.is-active .step-dot{background:var(--primary);color:#fff;border-color:var(--primary);box-shadow:0 0 0 4px var(--primary-soft)}
.step.is-active .step-label{color:var(--ink);font-weight:700}
.step.is-active .step-hint{color:var(--primary);font-weight:600}
.stepper-mobile{display:flex;flex-direction:column;gap:.45rem}
.stepper-mobile-row{display:flex;justify-content:space-between;align-items:center;gap:.75rem}
.stepper-meter{height:6px;background:#E7EEFF;border-radius:999px;overflow:hidden}
.stepper-meter>span{display:block;height:100%;background:var(--primary);border-radius:999px}
@media(min-width:720px){
  .stepper-desktop{display:flex}
  .stepper-mobile{display:none}
  .shell{padding:1.75rem 1.5rem 3rem}
}
.hero{text-align:center;margin:0 0 1.75rem}
.hero h1,.page-title{margin:0 0 .75rem;font-size:clamp(1.65rem,3vw,2.35rem);line-height:1.15;letter-spacing:-.02em;color:var(--ink)}
.hero p,.lede{margin:0 auto 1rem;max-width:40rem;color:var(--muted);font-size:1.05rem;line-height:1.6}
.promise{font-weight:700;color:var(--ink)}
.trust-row{display:flex;flex-wrap:wrap;gap:.5rem;justify-content:center;margin-top:1rem}
.trust-chip{display:inline-flex;align-items:center;gap:.4rem;padding:.45rem .8rem;background:var(--card);border:1px solid var(--border);
  border-radius:999px;font-size:13px;font-weight:600;color:var(--subtle);box-shadow:var(--shadow)}
.grid-2{display:grid;gap:1.25rem}
@media(min-width:860px){.grid-2{grid-template-columns:1.35fr .9fr}}
.card{background:var(--card);border:1px solid var(--border);border-radius:var(--r-lg);padding:1.35rem;box-shadow:var(--shadow);position:relative}
.card-accent-ok{border-top:3px solid var(--ok)}
.card-accent-active{border:2px solid var(--primary);box-shadow:var(--shadow-lg)}
.card-accent-warn{border-top:3px solid var(--warn)}
.card h2,.card h3{margin:0 0 .5rem;font-size:1.1rem;letter-spacing:-.01em}
.card p{margin:0 0 .85rem;color:var(--muted)}
.card p:last-child{margin-bottom:0}
.card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:.75rem;margin-bottom:.75rem}
.icon-tile{width:2.75rem;height:2.75rem;border-radius:12px;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-weight:700}
.icon-gh{background:var(--gh-bg);color:var(--ink)}
.icon-cf{background:var(--cf-bg);color:var(--cf-text)}
.icon-orch{background:var(--orch-bg);color:var(--primary-deep)}
.kv{background:var(--bg);border:1px solid var(--border);border-radius:var(--r);padding:.85rem 1rem;margin:.75rem 0}
.kv-row{display:flex;justify-content:space-between;gap:1rem;padding:.45rem 0;border-bottom:1px solid #F1F5F9;font-size:14px}
.kv-row:last-child{border-bottom:0}
.kv-key{color:var(--muted);font-weight:600}
.kv-val{color:var(--ink);text-align:right;overflow-wrap:anywhere}
.stack{display:flex;flex-direction:column;gap:1.25rem}
.section{margin-top:1.5rem;padding-top:1.35rem;border-top:1px solid var(--border)}
.section:first-child{margin-top:0;padding-top:0;border-top:0}
.section h2{margin:0 0 .55rem;font-size:1.2rem}
.muted{color:var(--muted)}.subtle{color:var(--subtle)}
.pill{display:inline-flex;align-items:center;gap:.35rem;padding:.25rem .7rem;background:var(--ok-soft);color:var(--ok);
  border-radius:999px;font-size:12px;font-weight:700}
.alert{padding:.9rem 1rem;border-radius:var(--r);margin:0 0 1rem;border:1px solid transparent}
.alert[role="alert"]{background:var(--danger-soft);border-color:#FECACA;color:#7F1D1D}
.alert[role="status"]{background:var(--ok-soft);border-color:#A7F3D0;color:#065F46}
.alert-warn{background:var(--warn-soft);border-color:#FDE68A;color:#92400E}
label{display:block;font-weight:600;font-size:14px;margin:0 0 .35rem;color:var(--ink)}
input,select,textarea{width:100%;min-height:44px;padding:.7rem .9rem;margin:0 0 1rem;border:1px solid var(--border);
  border-radius:var(--r);background:#fff;font:inherit;color:var(--ink)}
textarea{min-height:6.5rem;resize:vertical}
input:focus,select:focus,textarea:focus{border-color:var(--primary);box-shadow:0 0 0 3px rgba(37,99,235,.15)}
.help{display:block;margin:-.65rem 0 1rem;font-size:13px;color:var(--muted)}
button, .btn{appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:.45rem;min-height:44px;
  padding:.7rem 1.15rem;border-radius:var(--r);border:1px solid transparent;background:var(--primary);color:#fff;
  font:inherit;font-weight:700;cursor:pointer;text-decoration:none;box-shadow:var(--shadow)}
button:hover, .btn:hover{background:var(--primary-hover);color:#fff}
button:active, .btn:active{transform:translateY(1px)}
button.secondary, .btn-secondary{background:#fff;color:var(--ink);border-color:var(--border)}
button.secondary:hover, .btn-secondary:hover{background:#F8FAFC;color:var(--ink)}
button.danger, .btn-danger{background:var(--danger-soft);color:var(--danger);border-color:#FECACA}
button.danger:hover, .btn-danger:hover{background:#FEE2E2}
form button{width:auto}
.actions{display:flex;flex-wrap:wrap;gap:.65rem;align-items:center;margin-top:.5rem}
.promise-grid{display:grid;gap:1rem;margin-top:1.5rem}
@media(min-width:720px){.promise-grid{grid-template-columns:repeat(3,1fr)}}
.promise-card{background:var(--card);border:1px solid var(--border);border-radius:var(--r-lg);padding:1.25rem;box-shadow:var(--shadow)}
.promise-num{width:2.25rem;height:2.25rem;border-radius:10px;display:flex;align-items:center;justify-content:center;
  font-weight:700;margin-bottom:.75rem;background:var(--primary-soft);color:var(--primary-deep)}
.blueprint{background:var(--bg);border:1px solid var(--border);border-radius:var(--r);padding:1rem;margin:.75rem 0}
.blueprint-node{display:flex;align-items:center;gap:.75rem;padding:.35rem 0}
.blueprint-rail{margin-left:1rem;padding-left:.85rem;border-left:2px solid #C3C6D4;color:#94A3B8;font-size:11px;line-height:1.2;padding-top:.15rem;padding-bottom:.15rem}
.site-footer{margin-top:auto;border-top:1px solid var(--border);background:var(--card);padding:1.25rem 1rem;font-size:13px;color:var(--muted)}
.site-footer-inner{max-width:var(--max-wide);margin:0 auto;display:flex;flex-wrap:wrap;gap:.75rem 1.25rem;justify-content:space-between;align-items:center}
.site-footer a{color:var(--muted)}
.site-footer a:hover{color:var(--primary)}
code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.9em;background:#F1F5F9;padding:.1rem .35rem;border-radius:4px}
details{margin:1rem 0;padding:1rem;border:1px solid var(--border);border-radius:var(--r);background:var(--bg)}
details summary{cursor:pointer;font-weight:700}
ul{padding-left:1.2rem}
p{overflow-wrap:anywhere}
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
`;

export function stepperHtml(activeId='connect'){
  const ids=STEPS.map(s=>s.id);
  const activeIndex=Math.max(0,ids.indexOf(activeId));
  const desktop=STEPS.map((step,i)=>{
    const state=i<activeIndex?'is-done':i===activeIndex?'is-active':'';
    const mark=i<activeIndex?'✓':String(i+1);
    return `<div class="step ${state}"><div class="step-dot" aria-hidden="true">${mark}</div>
      <span class="step-label">${i+1}. ${escape(step.label)}</span>
      <span class="step-hint">${escape(step.hint)}</span></div>`;
  }).join('');
  const current=STEPS[activeIndex];
  const pct=Math.round(((activeIndex+1)/STEPS.length)*100);
  return `<nav class="stepper" aria-label="Launch progress">
    <div class="stepper-desktop">${desktop}</div>
    <div class="stepper-mobile">
      <div class="stepper-mobile-row">
        <span><span class="badge badge-orch">${activeIndex+1}</span> Step ${activeIndex+1} of ${STEPS.length}: ${escape(current.label)}</span>
        <span class="muted">${escape(current.hint)}</span>
      </div>
      <div class="stepper-meter" aria-hidden="true"><span style="width:${pct}%"></span></div>
    </div>
  </nav>`;
}

export function pageShell({title,body,step='connect',wide=false,showStepper=true,nav='home',omitTitle=false}={}){
  const historyCurrent=nav==='history'?' aria-current="page"':'';
  const homeCurrent=nav==='home'?' aria-current="page"':'';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)} | Launch & Own</title><style>${UI_CSS}</style></head>
<body>
<header class="site-header"><div class="site-header-inner">
  <div style="display:flex;align-items:center;gap:.75rem;flex-wrap:wrap">
    <a class="brand" href="/"><img src="/logo.png" alt=""><span>Launch & Own</span></a>
    <span class="badge badge-beta">Beta onboarding</span>
  </div>
  <div class="header-meta">
    <span class="badge badge-ok">Direct provider ownership · No stored passwords</span>
    <nav class="header-nav" aria-label="Primary">
      <a href="/"${homeCurrent}>New launch</a>
      <a href="/history"${historyCurrent}>History</a>
      <a href="/privacy">Privacy</a>
    </nav>
  </div>
</div></header>
<div class="shell${wide?'':' shell-narrow'}">
  ${showStepper?stepperHtml(step):''}
  ${omitTitle?'':`<h1 class="page-title">${escape(title)}</h1>`}
  ${body}
</div>
<footer class="site-footer"><div class="site-footer-inner">
  <div>Customer-controlled hosting · No paid email service · Beta onboarding · <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a></div>
  <div>Describe it. Launch it. Own it.</div>
</div></footer>
</body></html>`;
}

export function button(action,label,csrf,extra='',{variant}={}){
  const cls=variant==='secondary'?'secondary':variant==='danger'?'danger':'';
  return `<form action="${action}" method="POST"><input type="hidden" name="csrf" value="${escape(csrf)}">${extra}<button type="submit"${cls?` class="${cls}"`:''}>${escape(label)}</button></form>`;
}

export function linkButton(href,label,{variant}={}){
  const cls=variant==='secondary'?'btn btn-secondary':'btn';
  return `<a class="${cls}" href="${escape(href)}">${escape(label)}</a>`;
}

export {escape};
