/** Import compatibility report: renders an inventory (docs/contracts/IMPORTED_SITE_CONTRACTS.md §1) in plain language.
 * Presentation only. Not wired to a route until the WS1 inventory exists and M1.5 is authorized (#165/#171). */
import {escape} from './ui.mjs';

const CLASSES={
  static:['Static website','A finished website made of HTML and CSS files.'],
  static_multipage:['Static website, several pages','A finished website with more than one page.'],
  compiled_bundle:['Compiled website','Built by a tool such as Vite. It publishes exactly as uploaded.'],
  source_project:['Project source, not a built site','This is the code used to build a site, not the finished site. Build it first, then upload the output folder (often dist or build).'],
  unsupported:['Not supported','This upload is not a website we can publish.']
};
const REASONS={
  has_index_html:'Found the homepage (index.html).',
  minified_js_bundle:'Contains generated JavaScript. Those files are left exactly as they are.',
  source_project:'Looks like unbuilt project source.',
  bare_import:'Its JavaScript imports packages a browser cannot load without a build step.',
  missing_local_dependency:'Some pages point to files that are not in the upload.',
  external_dependency:'Loads some files from other websites. That is allowed, but those files are outside your control.',
  unsupported_file_type:'Contains file types we cannot publish.',
  config_file:'Contains configuration files. They are left exactly as they are.'
};
const KINDS={text:'text',link:'links',business_info:'business details',css_color:'colors'};

/** inventory: trusted server-computed object; every string is still escaped. */
export function importReportMarkup(inventory){
  const own=(o,k)=>typeof k==='string'&&Object.hasOwn(o,k); // prototype names like 'constructor' are not enum values
  if(!own(CLASSES,inventory?.classification)||typeof inventory.importable!=='boolean'||typeof inventory.serveReady!=='boolean'
     ||!Array.isArray(inventory.files)||!Array.isArray(inventory.reasons)
     ||!inventory.files.every(f=>typeof f?.path==='string'&&(f.editable==null||Array.isArray(f.editable)&&f.editable.every(k=>own(KINDS,k)))))
    throw new TypeError('Unknown inventory shape');
  const cls=CLASSES[inventory.classification];
  const publishes=inventory.importable&&inventory.serveReady&&!['source_project','unsupported'].includes(inventory.classification);
  const row=(ok,label,detail)=>'<li class="ir-row '+(ok?'ok':'no')+'"><span class="ir-mark" aria-hidden="true">'+(ok?'✓':'!')+'</span><div><strong>'+label+'</strong><p>'+detail+'</p></div></li>';
  const editable=inventory.files.filter(f=>Array.isArray(f.editable)&&f.editable.length);
  const kinds=[...new Set(editable.flatMap(f=>f.editable))].map(k=>KINDS[k]);
  // Unknown codes fail closed so a new contract code can never be silently hidden from the owner.
  if(!inventory.reasons.every(r=>own(REASONS,r)))throw new TypeError('Unknown inventory reason code');
  const reasons=inventory.reasons.map(r=>REASONS[r]);
  const files=inventory.files.map(f=>'<li><code>'+escape(f.path)+'</code> <small>'+
    (f.editable?.length?f.editable.map(k=>KINDS[k]).join(', '):'left as is')+'</small></li>').join('');
  return '<section class="ir" aria-labelledby="ir-title"><h2 id="ir-title">Compatibility check</h2>'+
    '<p class="ir-type"><span class="badge">'+cls[0]+'</span> '+cls[1]+'</p>'+
    '<ul class="ir-rows">'+
    row(inventory.importable,inventory.importable?'Upload accepted':'Upload not accepted',inventory.importable?'The files passed our upload checks.':'The files did not pass our upload checks.')+
    row(inventory.serveReady,inventory.serveReady?'Linked files found':'Some linked files are missing',inventory.serveReady?'Every page, style and script it links to is in the upload. This is a file check, not a test in a real browser.':'Some files it links to are missing or need a build step. Fix them before publishing.')+
    row(publishes,publishes?'Ready for a private preview':'Cannot be published yet',publishes?'Next you see a private preview. Nothing goes live until you review and approve it.':'Nothing will be published. Fix the issues above and upload again.')+
    '</ul>'+
    (reasons.length?'<details><summary>What we found</summary><ul>'+reasons.map(r=>'<li>'+r+'</li>').join('')+'</ul></details>':'')+
    (!publishes?'':'<div class="ir-future"><span class="badge">Beta · after launch</span><p>'+
    (kinds.length?'After launch you can update '+(kinds.length>1?kinds.slice(0,-1).join(', ')+' and '+kinds.at(-1):kinds[0])+' in '+editable.length+' '+(editable.length===1?'file':'files')+' from your toolkit. You see a preview first, and nothing changes until you approve it.':'No files in this upload are suitable for simple toolkit updates.')+
    ' You can also edit your site with your own AI coding tool.</p></div>')+
    '<details><summary>Files in this upload ('+inventory.files.length+')</summary><ul class="ir-files">'+files+'</ul></details></section>';
}
