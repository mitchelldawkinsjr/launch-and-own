/**
 * Cloudflare Pages PR-preview policy for owner-approved sites (#86).
 *
 * Pages preview URLs are PUBLIC by default, so approved launches provision with
 * preview_deployment_setting 'none'. This module only:
 *   - classifies a project's current preview exposure (read-only),
 *   - builds an exact opt-in / opt-out plan with an approval digest,
 *   - applies a plan the owner approved, re-checking fences before and after.
 * It is deliberately not wired to any route or job: callers need owner and
 * Domain approval plus orchestration review (#83) first.
 */

export const UPDATE_BRANCH_PATTERN = 'launch-and-own/site-*';
const ACCOUNT = /^[a-f0-9]{32}$/i;
const PROJECT = /^[a-z0-9][a-z0-9-]{0,57}$/;

/** #84 capability states this classifier maps onto. */
const CAPABILITY = Object.freeze({
  off: 'available_opt_in',
  scoped: 'active_verified',
  unsafe_all: 'active_verified',
  unsafe_custom: 'active_verified',
  unknown: 'not_available'
});

const sorted = list => Array.isArray(list) ? [...list].map(String).sort() : [];

/** Fence: the project must still be the owner's Git-connected Pages project. */
function assertFence(project, expected) {
  const c = project?.source?.config;
  if (!project || project.id !== expected.projectId || project.name !== expected.projectName ||
      project.source?.type !== 'github' ||
      String(c?.owner).toLowerCase() !== String(expected.owner).toLowerCase() ||
      String(c?.repo_id) !== String(expected.repositoryId) ||
      project.production_branch !== 'main' || c?.production_branch !== 'main' ||
      c?.production_deployments_enabled === false)
    throw Error('pages_preview_fence_mismatch');
}

/**
 * Read-only: how exposed are preview deployments on this project?
 *   off           no previews
 *   scoped        custom, only Launch & Own update branches, main excluded
 *   unsafe_all    every non-production branch gets a public preview
 *   unsafe_custom custom with other branch patterns
 *   unknown       not a Git-connected project we can reason about
 */
export function classifyPreviewPolicy(project) {
  const c = project?.source?.config;
  if (project?.source?.type !== 'github' || !c) return result('unknown', project);
  const setting = c.preview_deployment_setting;
  if (setting === 'none') return result('off', project);
  if (setting === 'all') return result('unsafe_all', project);
  if (setting === 'custom') {
    const inc = sorted(c.preview_branch_includes);
    const exc = sorted(c.preview_branch_excludes);
    const scoped = inc.length === 1 && inc[0] === UPDATE_BRANCH_PATTERN &&
      exc.length === 1 && exc[0] === 'main';
    return result(scoped ? 'scoped' : 'unsafe_custom', project);
  }
  return result('unknown', project);
}

function result(state, project) {
  const c = project?.source?.config || {};
  return Object.freeze({
    state,
    capability: CAPABILITY[state],
    publicPreviews: ['scoped', 'unsafe_all', 'unsafe_custom'].includes(state),
    setting: c.preview_deployment_setting ?? null,
    includes: sorted(c.preview_branch_includes),
    excludes: sorted(c.preview_branch_excludes),
    subdomain: project?.subdomain ?? null
  });
}

async function sha256(text) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

function targetConfig(action) {
  if (action === 'enable_scoped')
    return {preview_deployment_setting: 'custom',
      preview_branch_includes: [UPDATE_BRANCH_PATTERN], preview_branch_excludes: ['main']};
  if (action === 'disable')
    return {preview_deployment_setting: 'none',
      preview_branch_includes: [], preview_branch_excludes: []};
  throw Error('pages_preview_unknown_action');
}

/**
 * Build the exact change an owner would approve. The digest binds the project
 * identity, repo, the config observed now and the target, so a project that
 * changes between review and apply is refused.
 */
export async function planPreviewPolicy(project, expected, action) {
  assertFence(project, expected);
  const before = classifyPreviewPolicy(project);
  const target = targetConfig(action);
  const c = project.source.config;
  // Same writable fields provisioning sends, so a replace-style PATCH cannot drop the Git link.
  // shortcut: PATCH semantics for source.config not yet exercised live; trial on an owner test project before any caller ships.
  const config = {owner: c.owner, repo_name: c.repo_name, production_branch: 'main',
    production_deployments_enabled: true, ...target};
  const plan = {
    action,
    projectId: project.id,
    projectName: project.name,
    repositoryId: String(project.source.config.repo_id),
    before: {setting: before.setting, includes: before.includes, excludes: before.excludes},
    target,
    patch: {source: {type: 'github', config}}
  };
  const digest = await sha256(JSON.stringify([plan.action, plan.projectId, plan.repositoryId,
    plan.before, plan.target]));
  return Object.freeze({...plan, digest, noop: before.setting === target.preview_deployment_setting &&
    JSON.stringify(before.includes) === JSON.stringify(sorted(target.preview_branch_includes)) &&
    JSON.stringify(before.excludes) === JSON.stringify(sorted(target.preview_branch_excludes))});
}

/**
 * Apply an owner-approved plan. `cloudflare(path, opts)` is the strict provider
 * client used by provisioning (returns `result`, throws on HTTP errors).
 */
export async function applyPreviewPolicy({cloudflare, accountId, expected, action, approvedDigest}) {
  if (!ACCOUNT.test(String(accountId)) || !PROJECT.test(String(expected?.projectName)))
    throw Error('pages_preview_invalid_target');
  if (typeof approvedDigest !== 'string' || !/^[a-f0-9]{64}$/.test(approvedDigest))
    throw Error('pages_preview_not_approved');
  const path = '/accounts/' + accountId + '/pages/projects/' + encodeURIComponent(expected.projectName);
  const current = await cloudflare(path, {});
  const plan = await planPreviewPolicy(current, expected, action);
  if (plan.digest !== approvedDigest) throw Error('pages_preview_stale_approval');
  if (!plan.noop) await cloudflare(path, {method: 'PATCH', body: plan.patch});
  const after = await cloudflare(path, {});
  assertFence(after, expected);
  const state = classifyPreviewPolicy(after).state;
  if (state !== (action === 'enable_scoped' ? 'scoped' : 'off'))
    throw Error('pages_preview_verify_failed');
  return Object.freeze({action, state, projectId: after.id, changed: !plan.noop});
}

/** Owner-facing disclosure shown before any enable approval. */
export function previewExposureNotice(projectName) {
  return [
    `Preview links on ${projectName}.pages.dev are public: anyone with the link can open them.`,
    `Only branches named ${UPDATE_BRANCH_PATTERN} (Launch & Own update proposals) get previews; main and other branches do not.`,
    'Each preview build counts toward your Cloudflare Pages build allowance.',
    'Password-protecting previews needs Cloudflare Access, which you set up yourself in the Cloudflare dashboard.',
    'You can turn previews off again at any time; links already created keep working until those deployments are deleted.'
  ];
}
