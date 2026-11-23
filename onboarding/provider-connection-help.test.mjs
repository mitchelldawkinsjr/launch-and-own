import test from 'node:test';
import assert from 'node:assert/strict';
import {providerConnectionCards,providerHelpCss} from './provider-connection-help.mjs';

test('first-time onboarding shows both branded, clickable explainers and only GitHub login',()=>{
  const html=providerConnectionCards();
  assert.match(html,/<h2 id="provider-guides-heading">Why do I need these two accounts\?<\/h2>/);
  assert.match(html,/<span class="provider-icon provider-icon-gh"><svg /);
  assert.match(html,/<span class="provider-icon provider-icon-cf"><svg /);
  assert.equal((html.match(/<details>/g)||[]).length,2);
  assert.equal((html.match(/<summary /g)||[]).length,2);
  assert.match(html,/aria-label="Learn what GitHub is and why you need it"/);
  assert.match(html,/aria-label="Learn what Cloudflare is and why you need it"/);
  assert.match(html,/Keeps a private copy of your website files/);
  assert.match(html,/Saves a history of changes/);
  assert.match(html,/Publishes the website you approve/);
  assert.match(html,/secure HTTPS/);
  assert.match(html,/href="\/connect\/github">Connect GitHub<\/a>/);
  assert.doesNotMatch(html,/href="\/connect\/cloudflare"/);
  assert.match(html,/Next: finish the GitHub step first/);
  assert.match(html,/custom domain name may cost extra/);
});

test('after GitHub installation the Cloudflare action is shown without GitHub reconnect',()=>{
  const html=providerConnectionCards({
    githubStatus:'connected',githubAppInstalled:true,githubLogin:'tester',
    cloudflareStatus:'next'
  });
  assert.match(html,/GitHub connected as @tester/);
  assert.match(html,/href="\/connect\/cloudflare">Connect Cloudflare<\/a>/);
  assert.doesNotMatch(html,/href="\/connect\/github"/);
});

test('connected accounts show verified stages without duplicate OAuth actions',()=>{
  const html=providerConnectionCards({
    githubStatus:'connected',githubAppInstalled:true,githubLogin:'tester',
    cloudflareStatus:'connected',cloudflareAccountSelected:true
  });
  assert.match(html,/Cloudflare connected — hosting account selected/);
  assert.doesNotMatch(html,/href="\/connect\/(github|cloudflare)"/);
  assert.equal((html.match(/<details>/g)||[]).length,2);
});

test('HTML-escapes account names and does not inject scripts, events, or external assets',()=>{
  const html=providerConnectionCards({githubStatus:'connected',githubLogin:'<script>bad</script>'});
  assert.doesNotMatch(html,/<script|onerror=|onclick=|<img|href="https?:/);
  assert.match(html,/@&lt;script&gt;bad&lt;\/script&gt;/);
  assert.doesNotMatch(html,/<script>/);
  assert.doesNotMatch(providerHelpCss,/@import|url\(|expression\(/);
});

test('rejects unknown presentation states instead of rendering extra OAuth links',()=>{
  assert.throws(()=>providerConnectionCards({githubStatus:'bypass'}),TypeError);
  assert.throws(()=>providerConnectionCards({cloudflareStatus:'bypass'}),TypeError);
});
