import test from 'node:test';
import assert from 'node:assert/strict';
import {button,pageShell,stepperHtml} from './ui.mjs';

test('stepper marks active and completed steps without invented job percentages',()=>{
  const html=stepperHtml('preview');
  assert.match(html,/Step 3 of 5: Preview/);
  assert.match(html,/is-active/);
  assert.match(html,/is-done/);
  assert.doesNotMatch(html,/100% Done|fictitious/i);
});

test('page shell stays CSP-safe: no remote scripts, fonts, or trackers',()=>{
  const html=pageShell({title:'Welcome',body:'<p>Describe it. Launch it. Own it.</p>',step:'connect'});
  assert.match(html,/Launch &amp; Own|Launch & Own/);
  assert.match(html,/src="\/logo\.png"/);
  assert.doesNotMatch(html,/cdn\.tailwindcss|fonts\.googleapis|googletagmanager|material-symbols/i);
  assert.doesNotMatch(html,/<script/i);
});

test('buttons keep POST action, CSRF field, and label text',()=>{
  const html=button('/approve','Approve and create website','csrf-token','<input type="hidden" name="digest" value="abc">');
  assert.match(html,/action="\/approve"/);
  assert.match(html,/name="csrf" value="csrf-token"/);
  assert.match(html,/Approve and create website/);
  assert.match(html,/name="digest" value="abc"/);
});
