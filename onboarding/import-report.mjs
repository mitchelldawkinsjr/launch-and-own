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
  const cls=CLASSES[inventory?.classification];
  if(!cls||!Array.isArray(inventory.files)||!Array.isArray(inventory.reasons))throw new TypeError('Unknown inventory shape');
  const publishes=inventory.importable===true&&inventory.serveReady===true&&!['source_project','unsupported'].includes(inventory.classification);
  const row=(ok,label,detail)=>'<li class="ir-row '+(ok?'ok':'no')+'"><span class="ir-mark" aria-hidden="true">'+(ok?'✓':'!')+'</span><div><strong>'+label+'</strong><p>'+detail+'</p></div></li>';
  const editable=inventory.files.filter(f=>Array.isArray(f.editable)&&f.editable.length);
  const kinds=[...new Set(editable.flatMap(f=>f.editable))].map(k=>KINDS[k]).filter(Boolean);
  // Unknown codes fail closed so a new contract code can never be silently hidden from the owner.
  if(inventory.reasons.some(r=>!REASONS[r]))throw new TypeError('Unknown inventory reason code');
  const reasons=inventory.reasons.map(r=>REASONS[r]);
  const files=inventory.files.map(f=>'<li><code>'+escape(f.path)+'</code> <small>'+
    (f.editable?.length?escape(f.editable.map(k=>KINDS[k]||k).join(', ')):'left as is')+'</small></li>').join('');
  return '<section class="ir" aria-labelledby="ir-title"><h2 id="ir-title">Compatibility check</h2>'+
    '<p class="ir-type"><span class="badge">'+cls[0]+'</span> '+cls[1]+'</p>'+
    '<ul class="ir-rows">'+
    row(inventory.importable===true,inventory.importable===true?'Upload accepted':'Upload not accepted',inventory.importable===true?'The files passed our upload checks.':'The files did not pass our upload checks.')+
    row(inventory.serveReady===true,inventory.serveReady===true?'Ready to show in a browser':'May not display correctly',inventory.serveReady===true?'Every page and style it needs is included.':'Some files it needs are missing or need a build step. Fix them before publishing.')+
    row(publishes,publishes?'Can be published':'Cannot be published yet',publishes?'You will still review a private preview and approve it before anything goes live.':'Nothing will be published. Fix the issues above and upload again.')+
    '</ul>'+
    (reasons.length?'<details><summary>What we found</summary><ul>'+reasons.map(r=>'<li>'+r+'</li>').join('')+'</ul></details>':'')+
    '<div class="ir-future"><span class="badge badge-plan">Planned · not released</span><p>Launch &amp; Own editing for uploaded sites is not available yet. '+
    (kinds.length?'When it is, simple updates to '+(kinds.length>1?kinds.slice(0,-1).join(', ')+' and '+kinds.at(-1):kinds[0])+' in '+editable.length+' '+(editable.length===1?'file':'files')+' could be prepared for your review.':'No files in this upload would be suitable for simple guided updates.')+
    ' Today you can edit your site with your own AI coding tool.</p></div>'+
    '<details><summary>Files in this upload ('+inventory.files.length+')</summary><ul class="ir-files">'+files+'</ul></details></section>';
}
