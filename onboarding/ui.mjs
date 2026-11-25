// Launch & Own shared presentation layer: one token set for marketing, onboarding and toolkit.
// CSP-safe inline CSS only (the onboarding CSP has no img-src, scripts, or remote fonts).
const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export const STEPS=[
  {id:'connect',label:'Connect',hint:'Your accounts'},
  {id:'create',label:'Create',hint:'Your site'},
  {id:'preview',label:'Preview',hint:'Exact page'},
  {id:'approve',label:'Approve',hint:'Your decision'},
  {id:'launch',label:'Go live',hint:'Verified'}
];

export const UI_CSS=`:root{--ink:#14253c;--muted:#52637a;--line:#dbe5ef;--bg:#f6f9fc;--card:#fff;--blue:#2457b8;--blue-deep:#1a4291;
--blue-soft:#eaf0ff;--green:#176b55;--green-soft:#e0f4ec;--orange:#a74410;--orange-soft:#fff1e7;--warn:#8a5300;--warn-soft:#fff4dc;
--r:10px;--r-lg:18px;--shadow:0 1px 2px #15243a0a,0 8px 24px #15243a0d;--font:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
*{box-sizing:border-box}html{scroll-behavior:smooth}
body{margin:0;min-height:100vh;display:flex;flex-direction:column;font:16px/1.6 var(--font);color:var(--ink);background:var(--bg)}
a{color:var(--blue);text-underline-offset:3px}a:hover{color:var(--blue-deep)}
:focus-visible{outline:3px solid var(--blue);outline-offset:3px}
p{overflow-wrap:anywhere}code{font-size:.9em;background:#eef3f8;padding:1px 5px;border-radius:5px;overflow-wrap:anywhere}
.lo-sr{position:absolute!important;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.skip{position:absolute;left:12px;top:-60px;z-index:50;background:var(--ink);color:#fff;padding:8px 14px;border-radius:8px}.skip:focus{top:12px;color:#fff}
.site-header{position:sticky;top:0;z-index:20;background:#ffffffeb;border-bottom:1px solid var(--line)}
.site-header-inner{max-width:1200px;margin:0 auto;padding:10px clamp(14px,3vw,28px);display:flex;align-items:center;justify-content:space-between;gap:10px 18px;flex-wrap:wrap}
.brand{display:inline-flex;align-items:center;gap:10px;text-decoration:none;color:var(--ink);font-weight:750;letter-spacing:-.01em}
.brand-mark{display:inline-grid;place-items:center;width:34px;height:34px;border-radius:9px;background:#1747a6;color:#fff;font-weight:800;font-size:.8rem;letter-spacing:-.02em}
.badge{display:inline-block;padding:2px 9px;border-radius:999px;font-size:.72rem;font-weight:700;line-height:1.6;background:var(--blue-soft);color:var(--blue-deep)}
.badge-ok{background:var(--green-soft);color:var(--green)}.badge-plan{background:var(--warn-soft);color:var(--warn)}
.header-nav{display:flex;align-items:center;gap:2px 4px;flex-wrap:wrap}
.header-nav a{padding:7px 10px;border-radius:8px;text-decoration:none;color:var(--muted);font-weight:650;font-size:.88rem}
.header-nav a:hover,.header-nav a[aria-current="page"]{background:var(--blue-soft);color:var(--blue-deep)}
.header-nav a.nav-cta{background:var(--blue);color:#fff}.header-nav a.nav-cta:hover{background:var(--blue-deep);color:#fff}
.shell{flex:1;width:100%;max-width:760px;margin:0 auto;padding:clamp(16px,3vw,32px) clamp(12px,3vw,24px) 40px}
.shell-wide{max-width:1200px}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--r-lg);padding:clamp(18px,4vw,34px);box-shadow:var(--shadow)}
.page-title{font-size:clamp(1.6rem,4vw,2.2rem);line-height:1.15;letter-spacing:-.03em;margin:0 0 16px}
.card h2{font-size:1.2rem;letter-spacing:-.015em;margin:0 0 8px}
.card>section,.card>form+section{border-top:1px solid var(--line);padding-top:18px;margin-top:22px}
label{display:block;font-weight:650;margin-bottom:4px}
input,select,textarea{font:inherit;padding:10px 12px;width:100%;margin-bottom:16px;border:1px solid #a6b3c3;border-radius:8px;background:#fff;color:var(--ink)}
input:focus-visible,select:focus-visible,textarea:focus-visible{outline:3px solid #2457b855;outline-offset:0;border-color:var(--blue)}
input[type=radio],input[type=checkbox]{width:auto;margin:0 8px 0 0}textarea{resize:vertical}
button,.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:44px;padding:10px 18px;font:inherit;font-weight:700;
background:var(--blue);color:#fff;border:1px solid var(--blue);border-radius:10px;cursor:pointer;text-decoration:none}
button:hover,.btn:hover{background:var(--blue-deep);color:#fff}
.btn-secondary,button.secondary,form[action="/logout"] button{background:#fff;color:var(--blue);border-color:#b8c7dc}.btn-secondary:hover,button.secondary:hover,form[action="/logout"] button:hover{background:var(--blue-soft);color:var(--blue-deep)}
form{margin:0 0 10px}small,.muted{color:var(--muted)}
.pill{display:inline-block;padding:3px 11px;background:var(--green-soft);color:var(--green);border-radius:999px;font-weight:650;font-size:.9rem}
[role=alert]{padding:12px 14px;border-radius:var(--r);background:var(--warn-soft);color:#5c3800;border:1px solid #f0d49b}
[role=status]{padding:12px 14px;border-radius:var(--r);background:var(--green-soft);color:#0f4d3d}
details{border:1px solid var(--line);border-radius:var(--r);padding:10px 14px;margin:10px 0;background:#fbfcfe}
summary{cursor:pointer;font-weight:700;color:var(--blue)}details[open]>summary{margin-bottom:8px}
.stepper{margin:0 0 18px;padding:14px 16px;background:var(--card);border:1px solid var(--line);border-radius:var(--r-lg)}
.stepper ol{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:6px;counter-reset:s}
.step{display:grid;justify-items:center;text-align:center;gap:2px;font-size:.8rem;color:var(--muted);position:relative}
.step-dot{display:grid;place-items:center;width:30px;height:30px;border-radius:50%;border:1px solid var(--line);background:#f0f4f9;font-weight:750}
.step:not(:last-child)::after{content:"";position:absolute;top:15px;left:calc(50% + 20px);right:calc(-50% + 20px);height:2px;background:var(--line)}
.step.is-done .step-dot{background:var(--green);border-color:var(--green);color:#fff}.step.is-done::after{background:var(--green)}
.step.is-active .step-dot{background:var(--blue);border-color:var(--blue);color:#fff;box-shadow:0 0 0 4px var(--blue-soft)}
.step.is-active .step-label{color:var(--ink);font-weight:750}.step-hint{font-size:.72rem}
.stepper-now{display:none;font-weight:700;font-size:.9rem;margin-top:8px}
@media(max-width:560px){.step-label,.step-hint{display:none}.stepper-now{display:block}}
.site-footer{border-top:1px solid var(--line);background:#fff}
.site-footer-inner{max-width:1200px;margin:0 auto;padding:18px clamp(14px,3vw,28px);display:flex;justify-content:space-between;gap:8px 20px;flex-wrap:wrap;font-size:.84rem;color:var(--muted)}
@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important;animation:none!important}}`;

export const brandMark='<span class="brand-mark" aria-hidden="true">L&amp;O</span>';

export function stepperHtml(activeId='connect',{complete=false}={}){
  const active=Math.max(0,STEPS.findIndex(s=>s.id===activeId));
  const items=STEPS.map((step,i)=>{
    const done=complete||i<active;
    const state=done?'is-done':i===active?'is-active':'';
    return `<li class="step ${state}"${!done&&i===active?' aria-current="step"':''}><span class="step-dot" aria-hidden="true">${done?'✓':i+1}</span><span class="step-label">${escape(step.label)}</span><span class="step-hint">${escape(step.hint)}</span><span class="lo-sr">${done?'(done)':''}</span></li>`;
  }).join('');
  const now=complete?'All steps done: live and verified':`Step ${active+1} of ${STEPS.length}: ${STEPS[active].label}`;
  return `<nav class="stepper" aria-label="Launch progress"><ol>${items}</ol><p class="stepper-now">${escape(now)}</p></nav>`;
}

const NAVS={
  app:[['/','Setup'],['/toolkit','Toolkit'],['/history','Launches']],
  marketing:[['#explore','How it works'],['#faq','FAQ'],['/toolkit','Owner toolkit'],['#get-started','Get started','nav-cta']]
};

/** css: extra trusted inline CSS; nav: 'app' | 'marketing'; current: href to mark as the current page. */
export function pageShell({title,body,css='',step,stepComplete=false,wide=false,nav='app',current,omitTitle=false}={}){
  const links=(NAVS[nav]||NAVS.app).map(([href,label,cls])=>
    `<a href="${href}"${cls?` class="${cls}"`:''}${href===current?' aria-current="page"':''}>${label}</a>`).join('');
  const content=omitTitle?body:`<div class="card"><h1 class="page-title">${escape(title)}</h1>${body}</div>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} | Launch & Own</title><style>${UI_CSS}${css}</style></head><body><a class="skip" href="#main">Skip to content</a><header class="site-header"><div class="site-header-inner"><a class="brand" href="/">${brandMark}<span>Launch &amp; Own</span><span class="badge">Beta</span></a><nav class="header-nav" aria-label="Primary">${links}</nav></div></header><main id="main" class="shell${wide?' shell-wide':''}">${step?stepperHtml(step,{complete:stepComplete}):''}${content}</main><footer class="site-footer"><div class="site-footer-inner"><span>Customer-controlled hosting · No paid email service · Beta onboarding · <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a></span><span>Describe it. Launch it. Own it.</span></div></footer></body></html>`;
}

export {escape};
