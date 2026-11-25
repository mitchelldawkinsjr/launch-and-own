import test from 'node:test';
import assert from 'node:assert/strict';
import {importReportMarkup} from './import-report.mjs';

const file=(path,editable=[],type='html')=>({path,bytes:100,type,editable,readOnlyReason:editable.length?null:'config_file'});
const staticSite={v:1,classification:'static',importable:true,serveReady:true,reasons:['has_index_html'],
  files:[file('public/index.html',['text','link','business_info']),file('public/style.css',['css_color'],'css')]};

test('static site can publish, and editing stays labelled planned',()=>{
  const html=importReportMarkup(staticSite);
  assert.match(html,/Upload accepted/);
  assert.match(html,/Ready to show in a browser/);
  assert.match(html,/Can be published/);
  assert.match(html,/private preview and approve it/);
  assert.match(html,/Planned · not released/);
  assert.match(html,/editing for uploaded sites is not available yet/);
  assert.match(html,/text, links, business details and colors in 2 files/);
  assert.doesNotMatch(html,/<(?:script|form|img)\b|\bon[a-z]+=/i);
});

test('source project and missing files are never shown as publishable',()=>{
  const source=importReportMarkup({v:1,classification:'source_project',importable:true,serveReady:false,reasons:['source_project','bare_import'],files:[file('public/index.html'),file('public/src/main.js',[],'js')]});
  assert.match(source,/Project source, not a built site/);
  assert.match(source,/Cannot be published yet/);
  assert.match(source,/packages a browser cannot load/);
  assert.match(source,/No files in this upload would be suitable/);
  assert.doesNotMatch(source,/Can be published</);
  const missing=importReportMarkup({...staticSite,serveReady:false,reasons:['has_index_html','missing_local_dependency']});
  assert.match(missing,/May not display correctly/);
  assert.match(missing,/Cannot be published yet/);
});

test('paths are escaped and unknown shapes fail closed',()=>{
  const html=importReportMarkup({...staticSite,files:[file('public/<img src=x onerror=alert(1)>.html',['text'])]});
  assert.match(html,/&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html,/<img/);
  assert.throws(()=>importReportMarkup({classification:'mystery',files:[],reasons:[]}),TypeError);
  assert.throws(()=>importReportMarkup(null),TypeError);
});
