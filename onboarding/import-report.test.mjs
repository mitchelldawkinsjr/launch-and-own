import test from 'node:test';
import assert from 'node:assert/strict';
import {importReportMarkup} from './import-report.mjs';

const file=(path,editable=[],type='html')=>({path,bytes:100,type,editable,readOnlyReason:editable.length?null:'config_file'});
const staticSite={v:1,classification:'static',importable:true,serveReady:true,reasons:['has_index_html'],
  files:[file('public/index.html',['text','link','business_info']),file('public/style.css',['css_color'],'css')]};

test('static site can publish, and editing stays labelled planned',()=>{
  const html=importReportMarkup(staticSite);
  assert.match(html,/Upload accepted/);
  assert.match(html,/Linked files found/);
  assert.match(html,/not a test in a real browser/);
  assert.match(html,/Ready for a private preview/);
  assert.match(html,/review and approve it/);
  assert.match(html,/Beta · after launch/);
  assert.match(html,/After launch you can update text, links, business details and colors in 2 files from your toolkit/);
  assert.match(html,/you merge the change yourself/);
  assert.doesNotMatch(html,/<(?:script|form|img)\b|\bon[a-z]+=/i);
});

test('source project and missing files are never shown as publishable',()=>{
  const source=importReportMarkup({v:1,classification:'source_project',importable:true,serveReady:false,reasons:['source_project','bare_import'],files:[file('public/index.html'),file('public/src/main.js',[],'js')]});
  assert.match(source,/Project source, not a built site/);
  assert.match(source,/Cannot be published yet/);
  assert.match(source,/packages a browser cannot load/);
  assert.doesNotMatch(source,/Beta · after launch/,'no editing promise for an upload that cannot publish');
  assert.doesNotMatch(source,/Ready for a private preview</);
  const missing=importReportMarkup({...staticSite,serveReady:false,reasons:['has_index_html','missing_local_dependency']});
  assert.match(missing,/Some linked files are missing/);
  assert.match(missing,/Cannot be published yet/);
});

test('paths are escaped and unknown shapes fail closed',()=>{
  const html=importReportMarkup({...staticSite,files:[file('public/<img src=x onerror=alert(1)>.html',['text'])]});
  assert.match(html,/&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html,/<img/);
  assert.throws(()=>importReportMarkup({classification:'mystery',files:[],reasons:[]}),TypeError);
  assert.throws(()=>importReportMarkup(null),TypeError);
  assert.throws(()=>importReportMarkup({...staticSite,reasons:['has_index_html','brand_new_code']}),TypeError);
  for(const bad of [{classification:'constructor'},{reasons:['toString']},{importable:'yes'},{serveReady:1},
    {files:[{path:'a.html',editable:['__proto__']}]},{files:[{editable:[]}]},{files:[null]}])
    assert.throws(()=>importReportMarkup({...staticSite,...bad}),TypeError,JSON.stringify(bad));
});

test('report renders every shared fixture inventory consistently with the approved contract',async()=>{
  const {readdirSync,readFileSync,existsSync}=await import('node:fs');
  const root=new URL('../fixtures/imported-sites/',import.meta.url);
  const names=readdirSync(root).filter(n=>existsSync(new URL(n+'/expected-inventory.json',root)));
  assert.ok(names.length>=6,'shared fixtures present');
  for(const name of names){
    const inv=JSON.parse(readFileSync(new URL(name+'/expected-inventory.json',root),'utf8'));
    const html=importReportMarkup(inv);
    const publishable=inv.importable&&inv.serveReady&&!['source_project','unsupported'].includes(inv.classification);
    assert.equal(html.includes('Ready for a private preview<'),publishable,name+': publishable state');
    assert.equal(html.includes('Cannot be published yet<'),!publishable,name);
    const found=html.match(/<summary>What we found<\/summary><ul>([\s\S]*?)<\/ul>/);
    assert.equal(found?(found[1].match(/<li>/g)||[]).length:0,inv.reasons.length,name+': every reason code has plain language');
    const editable=inv.files.filter(f=>f.editable.length).length;
    if(publishable)assert.ok(editable?html.includes(' in '+editable+' file'):html.includes('No files in this upload are suitable'),name+': editing note');
    assert.equal(html.includes('Beta · after launch'),publishable,name+': editing note only for publishable uploads');
    assert.doesNotMatch(html,/not available yet/);
  }
});
