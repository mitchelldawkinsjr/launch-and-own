/** CSP-safe tokens/layout from Stitch "Launch & Own Onboarding Redesign"
 * (Warm Self-Service Modern). No remote fonts, icons, or scripts.
 */
export const STITCH_TOKEN_CSS = `:root{
--ink:#0F172A;--muted:#434652;--line:#E5E5DE;--bg:#FBFBF9;--card:#FFFFFF;
--blue:#2563EB;--blue-deep:#1D4ED8;--blue-soft:#EFF6FF;--blue-brand:#174CA5;
--green:#059669;--green-soft:#D1FAE5;--green-live:#10B981;
--orange:#D97706;--orange-soft:#FFF7ED;--warn:#D97706;--warn-soft:#FFFBEB;
--danger:#DC2626;--danger-soft:#FEF2F2;
--r:8px;--r-lg:16px;--r-xl:24px;
--shadow:0 1px 3px rgba(15,23,42,.04),0 6px 16px -4px rgba(15,23,42,.03);
--shadow-lg:0 4px 6px -1px rgba(15,23,42,.06),0 12px 24px -4px rgba(15,23,42,.06);
--font:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
--badge-gh-bg:#F1F5F9;--badge-gh-ink:#0F172A;
--badge-cf-bg:#FFF7ED;--badge-cf-ink:#C2410C;
--badge-lo-bg:#EFF6FF;--badge-lo-ink:#174CA5;
--surface-low:#F1F5F9
}`;

export const STITCH_SURFACE_CSS = `
.site-header{background:rgba(255,255,255,.95);backdrop-filter:blur(12px);border-bottom:1px solid var(--line);box-shadow:0 1px 8px rgba(0,0,0,.03)}
.brand-mark{background:var(--blue-brand);border-radius:12px;width:40px;height:40px}
.badge{background:var(--blue-soft);color:var(--blue-brand)}
.card{border-radius:var(--r-lg);border-color:var(--line);box-shadow:var(--shadow);padding:clamp(20px,4vw,40px)}
.page-title{letter-spacing:-.025em;color:var(--ink)}
button,.btn{background:var(--blue);border-color:var(--blue);border-radius:var(--r);min-height:44px;box-shadow:var(--shadow)}
button:hover,.btn:hover{background:var(--blue-deep)}
.btn-secondary,button.secondary,form[action="/logout"] button{border-color:var(--line);color:var(--ink)}
.btn-secondary:hover,button.secondary:hover{background:#F8FAFC;color:var(--ink)}
.pill{background:var(--green-soft);color:var(--green);border-radius:999px}
.step.is-done .step-dot{background:var(--green);border-color:var(--green)}.step.is-done::after{background:var(--green)}
.step.is-active .step-dot{background:var(--blue);border-color:var(--blue);box-shadow:0 0 0 4px var(--blue-soft)}
.lo-badge{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;font-size:.72rem;font-weight:700;line-height:1.4}
.lo-badge-gh{background:var(--badge-gh-bg);color:var(--badge-gh-ink);border:1px solid #CBD5E1}
.lo-badge-cf{background:var(--badge-cf-bg);color:var(--badge-cf-ink);border:1px solid #FFEDD5}
.lo-badge-lo{background:var(--badge-lo-bg);color:var(--badge-lo-ink);border:1px solid #BFDBFE}
.lo-badge-live{background:var(--green-soft);color:var(--green)}
.lo-badge-warn{background:var(--orange-soft);color:var(--orange);border:1px solid #FFEDD5}
.lo-hero{display:grid;gap:12px;margin:0 0 28px}
.lo-hero .eyebrow{display:inline-flex;align-items:center;gap:8px;flex-wrap:wrap}
.lo-hero h1,.lo-page>h1{margin:0;font-size:clamp(1.8rem,3.6vw,2.4rem);letter-spacing:-.025em;line-height:1.12;color:var(--ink);max-width:24ch}
.lo-hero>p{margin:0;max-width:68ch;color:var(--muted);font-size:1.02rem}
.lo-toolbar{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:4px 0 0}
.lo-stat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,160px),1fr));gap:12px;margin:0 0 28px}
.lo-stat{background:var(--card);border:1px solid var(--line);border-radius:var(--r-lg);padding:16px 18px;box-shadow:var(--shadow)}
.lo-stat strong{display:block;font-size:1.1rem;letter-spacing:-.015em;margin:4px 0;font-variant-numeric:tabular-nums}
.lo-stat span{font-size:.72rem;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.05em}
.lo-stat p{margin:4px 0 0;font-size:.86rem;color:var(--muted)}
.lo-page{display:grid;gap:28px}
::selection{background:#BFDBFE;color:var(--ink)}
input,textarea,select{caret-color:var(--blue)}
.lo-page>.lo-panel,.lo-dual>*,.lo-infra>*,.opt-module,.lo-step-card,.lo-checklist,.lo-pr-card,.lo-own-card,.lo-howto,.tk-block{background:var(--card);border:1px solid var(--line);border-radius:var(--r-lg);box-shadow:var(--shadow)}
.lo-panel{padding:clamp(18px,3vw,28px)}
.lo-panel>h2{margin:0 0 10px;font-size:1.2rem;letter-spacing:-.015em}
.lo-dual{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr));gap:16px;margin:0}
.lo-dual>div{padding:20px;display:grid;gap:10px;align-content:start}
.lo-dual h3{margin:0;font-size:1.08rem;display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.lo-section-title{margin:0 0 12px;font-size:1.15rem;letter-spacing:-.015em}
.lo-url{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 14px;border-radius:var(--r);background:var(--surface-low);margin:4px 0}
.lo-url p{margin:0}.lo-url code{font-size:.92rem}
.lo-callout{padding:12px 14px;border-radius:var(--r);margin:4px 0;font-size:.92rem}
.lo-callout-warn{background:var(--orange-soft);border:1px solid #FFEDD5;color:#9A3412}
.lo-callout-info{background:var(--blue-soft);border:1px solid #BFDBFE;color:#1E3A8A}
.lo-callout-ok{background:var(--green-soft);border:1px solid #A7F3D0;color:#065F46}
.lo-infra{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(0,1fr);gap:16px;margin:0}
@media(max-width:860px){.lo-infra{grid-template-columns:1fr}}
.lo-infra>div{padding:20px;display:grid;gap:14px}
.lo-infra .lo-head{display:flex;align-items:center;gap:12px}
.lo-infra .lo-ico{width:40px;height:40px;border-radius:var(--r);display:grid;place-items:center;font-weight:800;font-size:.75rem;flex:0 0 auto}
.lo-infra .lo-ico-gh{background:var(--badge-gh-bg);color:var(--badge-gh-ink)}
.lo-infra .lo-ico-cf{background:var(--badge-cf-bg);color:var(--badge-cf-ink)}
.lo-infra h3{margin:0;font-size:1.05rem}
.lo-infra .lo-cta{margin-top:auto}
.lo-infra .lo-cta .btn,.lo-infra .lo-cta a.btn{width:100%}
.lo-kv{display:grid;gap:0;margin:0;padding:12px;border-radius:var(--r);background:var(--surface-low)}
.lo-kv div{display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px solid #E2E8F0;font-size:.9rem}
.lo-kv div:last-child{border-bottom:0;padding-bottom:0}
.lo-kv div:first-child{padding-top:0}
.lo-kv .k{color:var(--muted)}
.lo-steps{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:0}
@media(max-width:860px){.lo-steps{grid-template-columns:1fr 1fr}}
@media(max-width:520px){.lo-steps{grid-template-columns:1fr}}
.lo-step-card{padding:18px;display:grid;gap:10px;min-height:148px}
.lo-step-card .n{width:32px;height:32px;border-radius:50%;display:grid;place-items:center;background:var(--blue);color:#fff;font-weight:800;font-size:.85rem}
.lo-step-card h3{margin:0;font-size:.98rem}
.lo-step-card p{margin:0;font-size:.88rem;color:var(--muted)}
.lo-checklist{padding:20px;display:grid;gap:4px}
.lo-checklist-head{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:8px 16px;margin-bottom:8px}
.lo-checklist h2{margin:0;font-size:1.15rem}
.lo-check{display:grid;grid-template-columns:1fr auto;gap:8px 16px;align-items:start;padding:14px 0;border-top:1px solid #F1F5F9}
.lo-check:first-of-type{border-top:0}
.lo-check strong{display:block}
.lo-check p{margin:2px 0 0;font-size:.88rem;color:var(--muted)}
.lo-pipe-card{display:grid;gap:16px;margin:0 0 4px}
.lo-pipe-head{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:8px 16px}
.lo-pipe-head .muted{font-size:.9rem}
.lo-pipe{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:0;list-style:none;padding:0}
.lo-pipe li{background:var(--surface-low);border:1px solid transparent;border-radius:var(--r-lg);padding:16px 14px;text-align:left;min-height:132px;display:grid;gap:8px;align-content:start}
.lo-pipe-top{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 0 2px}
.lo-pipe .n{display:grid;place-items:center;width:30px;height:30px;margin:0;border-radius:50%;background:#fff;border:1px solid var(--line);font-weight:800;font-size:.8rem}
.lo-pipe-tag{font-size:.68rem;font-weight:700;padding:3px 8px;border-radius:999px;background:#fff;color:var(--green);border:1px solid #A7F3D0}
.lo-pipe-tag-now{color:var(--blue);border-color:#BFDBFE;background:#fff}
.lo-pipe li.is-done{border-color:#A7F3D0;background:#F0FDF4}
.lo-pipe li.is-done .n{background:var(--green);color:#fff;border-color:var(--green)}
.lo-pipe li.is-active{border-color:#BFDBFE;background:var(--blue-soft)}
.lo-pipe li.is-active .n{background:var(--blue);color:#fff;border-color:var(--blue);box-shadow:0 0 0 4px #DBEAFE}
.lo-pipe strong{display:block;font-size:.9rem;margin:0}
.lo-pipe p{margin:0;font-size:.8rem;color:var(--muted);line-height:1.45}
@media(max-width:700px){.lo-pipe{grid-template-columns:1fr 1fr}}
.lo-split{display:grid;grid-template-columns:minmax(0,1.45fr) minmax(0,1fr);gap:16px}
@media(max-width:860px){.lo-split{grid-template-columns:1fr}}
.lo-pr-card,.lo-own-card,.lo-howto{padding:22px;display:grid;gap:14px}
.lo-pr-card>h2,.lo-own-card>h2,.lo-howto>h2{margin:0;font-size:1.2rem;letter-spacing:-.015em}
.lo-howto .lo-steps{margin-top:4px}
.tk-site{background:transparent;border:0;border-radius:0;padding:0;margin:0;overflow:visible;box-shadow:none;display:grid;gap:16px}
.tk-site .tk-tabs{margin:0;padding:5px;border:1px solid var(--line);border-radius:14px;background:var(--card);box-shadow:var(--shadow)}
.tk-site .tk-panel{padding:0;border:0;margin:0;display:grid;gap:16px}
.tk-site .tk-panel>h3{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.tk-site .tk-actions{display:flex;flex-wrap:wrap;gap:10px;margin:0}
.tk-block{padding:20px 22px}
.tk-block>h3,.tk-block>h4{margin:0 0 12px;font-size:1.12rem}
.opt-group{margin:0;padding:0;border:0;background:transparent;box-shadow:none;display:grid;gap:14px}
.opt-phase-head{display:grid;gap:6px}
.opt-phase-head>h2,.opt-group>h2{margin:0;font-size:1.25rem;display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.opt-phase-head>.muted,.opt-group>.muted{margin:0}
.opt-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr));gap:16px}
.opt-module{padding:22px;display:grid;gap:12px;align-content:start;min-height:240px}
.opt-module h3{margin:0;font-size:1.05rem;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.opt-module .tag,.opt-phase-head .tag,.opt-group>h2 .tag{font-size:.7rem;font-weight:700;padding:3px 8px;border-radius:999px;background:var(--surface-low);color:var(--muted)}
.opt-module .tag-safe,.opt-phase-head .tag-safe,.opt-group>h2 .tag-safe{background:var(--green-soft);color:var(--green)}
.opt-module .tag-edge,.opt-phase-head .tag-edge,.opt-group>h2 .tag-edge{background:var(--orange-soft);color:var(--orange)}
.btn.btn-secondary{background:#fff;color:var(--ink);border-color:var(--line);box-shadow:none}
.btn.btn-secondary:hover{background:#F8FAFC;color:var(--ink)}
.opt-module p{margin:0;font-size:.92rem;color:var(--muted)}
.opt-module form{margin:0;display:grid;gap:8px}
.opt-module label{font-size:.9rem}
.opt-module input,.opt-module select,.opt-module textarea{margin-bottom:0}
.opt-module button,.opt-module .btn{justify-self:start;margin-top:4px}
.opt-ribbon{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:16px 24px;padding:22px 24px;background:var(--card);border:1px solid var(--line);border-radius:var(--r-lg);box-shadow:var(--shadow)}
.opt-ribbon h3{margin:0 0 4px;font-size:1.08rem}
.opt-ribbon p{margin:0;color:var(--muted);font-size:.92rem;max-width:52ch}
.opt-ribbon-actions{display:flex;flex-wrap:wrap;align-items:center;gap:10px}
.upd-ladder{list-style:none;margin:0 0 18px;padding:0;display:grid;gap:8px}
.upd-ladder li{display:grid;grid-template-columns:28px 1fr;gap:12px;align-items:start;padding:12px 14px;border:1px solid var(--line);border-radius:var(--r);background:#fff}
.upd-ladder .dot{display:grid;place-items:center;width:28px;height:28px;border-radius:50%;background:#F1F5F9;color:var(--muted);font-weight:800;font-size:.8rem}
.upd-ladder li.is-done .dot{background:var(--green);color:#fff}
.upd-ladder li.is-active{border-color:#BFDBFE;background:var(--blue-soft)}
.upd-ladder li.is-active .dot{background:var(--blue);color:#fff;box-shadow:0 0 0 4px #DBEAFE}
.upd-ladder strong{display:block;margin-bottom:2px}
.upd-ladder p{margin:0;color:var(--muted);font-size:.92rem}
.lo-edit{display:grid;gap:18px;max-width:720px}
.lo-edit .lo-panel{padding:clamp(18px,3vw,28px)}
.shell-wide .lo-page{max-width:1024px;margin:0 auto;width:100%}
.tk-site-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px 18px;padding:20px 22px;background:var(--card);border:1px solid var(--line);border-radius:var(--r-lg);box-shadow:var(--shadow)}
.tk-site-head h2{padding:0;margin:0;font-size:clamp(1.25rem,2.5vw,1.55rem);letter-spacing:-.02em}
.tk-site-head .pill{margin:0}
.tk-site-head .tk-actions{margin:0}
.lo-pipe-status{margin:0 0 10px;color:var(--muted);font-size:.95rem}
.lo-pipe-status strong{color:var(--ink)}
.lo-found{padding:18px 20px;border-radius:var(--r-lg);background:var(--surface-low);border:1px solid var(--line)}
.lo-found>h4{margin:0 0 10px}
.lo-decision{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:12px 0 8px}
.lo-decision button{margin:0}
.lo-disconnect{margin-top:28px;padding-top:18px;border-top:1px solid var(--line)}
.lo-disconnect form{margin:0}
`;
