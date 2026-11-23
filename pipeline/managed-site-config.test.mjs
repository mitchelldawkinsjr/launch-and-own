import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {normalizeSite, renderSite} from '../site/render-site.mjs';
import {
  MANAGED_CONFIG_PATH, MANAGED_CONFIG_SCHEMA, ManagedSiteConfigError,
  planManagedSiteSidecarMigration, planManagedSiteStructuredEdit
} from './managed-site-config.mjs';

const sha = text => createHash('sha256').update(text, 'utf8').digest('hex');
const site = normalizeSite({name: 'Willow Studio', tagline: 'Original homepage',
  about: 'Original about our photography studio.', services: ['Portraits', 'Events'],
  theme: 'forest', contactEmail: 'hello@willow.example'});
const mainSha = 'a'.repeat(40);
const gitBlobSha = 'b'.repeat(40);
const sidecarBlobSha = 'd'.repeat(40);
const id = 'managed_42_project-fixture';
const html = renderSite(site);
function source(overrides = {}) {
  return {status: 'github_current_source_verified',
    siteId: id, baseCommitSha: mainSha, homepageGitBlobSha: gitBlobSha,
    homepageHtmlSha256: sha(html), publicationVerified: false,
    editMode: 'approved_migration_required', html, ...overrides};
}
const evidence = (exists, overrides = {}) => ({
  path: MANAGED_CONFIG_PATH, exists, refCommitSha: mainSha,
  ...(exists ? {blobSha: sidecarBlobSha} : {}), ...overrides
});
const migrated = () => planManagedSiteSidecarMigration({
  currentSource: source(), sidecarEvidence: evidence(false), candidateSite: site
});
async function currentEdit({patch = {}, raw, src, ev} = {}) {
  const first = raw ?? (await migrated()).files[0].content;
  return planManagedSiteStructuredEdit({
    currentSource: src ?? source(), sidecarEvidence: ev ?? evidence(true),
    sidecarRaw: first, patch
  });
}
function rejected(code) {
  return e => {
    assert(e instanceof ManagedSiteConfigError);
    assert.equal(e.code, code);
    assert(!e.message.includes('hello@willow.example'));
    return true;
  };
}

test('migration is a sidecar-only review: existing homepage exact bytes are unchanged', async () => {
  const plan = await migrated();
  assert.equal(plan.status, 'review_required');
  assert.equal(plan.kind, 'add_sidecar_only');
  assert.equal(plan.requiresSeparateHumanApproval, true);
  assert.equal(plan.readyForProviderWrite, false);
  assert.equal(plan.publicationVerified, false);
  assert.equal(plan.files.length, 1);
  assert.deepEqual(plan.files.map(f => ({path: f.path, action: f.action})),
    [{path: MANAGED_CONFIG_PATH, action: 'create'}]);
  assert.equal(plan.source.siteId, id);
  assert.equal(plan.source.expectedBaseCommitSha, mainSha);
  assert.equal(plan.source.existingHomepageGitBlobSha, gitBlobSha);
  assert.equal(plan.source.existingHtmlSha256, sha(html));
  assert.equal(plan.proposedHtmlSha256, sha(html));
  assert.match(plan.approvalReviewDigest, /^[a-f0-9]{64}$/);
  const doc = JSON.parse(plan.files[0].content);
  assert.equal(doc.schema, MANAGED_CONFIG_SCHEMA);
  assert.equal(doc.version, 1);
  assert.deepEqual(doc.site, site);
  assert.equal(doc.htmlSha256, sha(html));
  assert.equal(plan.proposedSidecarSha256, sha(plan.files[0].content));
  assert.equal(plan.files[0].content, JSON.stringify(doc, null, 2) + '\n');
});

test('migration requires separate exact current-main absence proof, not client history state', async () => {
  for (const ev of [undefined, {}, evidence(true), evidence(false, {refCommitSha: 'f'.repeat(40)}),
    evidence(false, {path: 'public/site-config.json'}),
    evidence(false, {blobSha: 'a'.repeat(40)})]) {
    await assert.rejects(planManagedSiteSidecarMigration({
      currentSource: source(), sidecarEvidence: ev, candidateSite: site
    }), rejected('pinned_sidecar_evidence_required'));
  }
});

test('legacy homepage with arbitrary hand edits cannot receive a fake canonical config', async () => {
  const altered = html.replace('Original homepage', 'Custom homepage');
  await assert.rejects(planManagedSiteSidecarMigration({
    currentSource: source({html: altered, homepageHtmlSha256: sha(altered)}),
    sidecarEvidence: evidence(false), candidateSite: site
  }), rejected('legacy_html_not_exactly_reproducible'));
});

test('a BOM is not silently stripped or rewritten by the migration plan', async () => {
  const bomHtml = '\ufeff' + html;
  await assert.rejects(planManagedSiteSidecarMigration({
    currentSource: source({html: bomHtml, homepageHtmlSha256: sha(bomHtml)}),
    sidecarEvidence: evidence(false), candidateSite: site
  }), rejected('legacy_html_not_exactly_reproducible'));
});

test('source must be SHA pinned and carry a valid exact-byte digest', async () => {
  const changes = [
    {status: 'unverified'}, {siteId: '../../owner'},
    {baseCommitSha: 'bad'}, {homepageGitBlobSha: 'not-a-git-blob'},
    {homepageHtmlSha256: 'c'.repeat(64)}, {publicationVerified: true},
    {editMode: 'ready-to-write'}, {html: ''}, {html: '<html>changed</html>'}
  ];
  for (const change of changes) {
    await assert.rejects(planManagedSiteSidecarMigration({
      currentSource: source(change), sidecarEvidence: evidence(false), candidateSite: site
    }), rejected(Object.hasOwn(change, 'homepageHtmlSha256') ||
      Object.hasOwn(change, 'html') ? 'current_source_digest_mismatch' : 'current_source_proof_required'));
  }
});

test('invalid proposed site fields are never interpreted as approved HTML', async () => {
  for (const candidate of [
    {name: ''}, {name: 'Bad Site', theme: 'evil'},
    {name: 'Willow Studio', services: [33]}, null, []
  ]) {
    await assert.rejects(planManagedSiteSidecarMigration({
      currentSource: source(), sidecarEvidence: evidence(false), candidateSite: candidate
    }), rejected('site_fields_invalid'));
  }
});

test('structured edit starts with current canonical config and preserves all unedited fields', async () => {
  const next = await currentEdit({patch: {tagline: 'Updated once'}});
  assert.equal(next.status, 'review_required');
  assert.equal(next.kind, 'update_homepage_and_sidecar');
  assert.equal(next.files.length, 2);
  assert.deepEqual(next.files.map(f => ({path: f.path, action: f.action})), [
    {path: 'public/index.html', action: 'replace'},
    {path: MANAGED_CONFIG_PATH, action: 'replace'}
  ]);
  assert.equal(next.existingSidecarGitBlobSha, sidecarBlobSha);
  const nextDoc = JSON.parse(next.files[1].content);
  assert.equal(nextDoc.site.tagline, 'Updated once');
  assert.equal(nextDoc.site.about, site.about);
  assert.deepEqual(nextDoc.site.services, site.services);
  assert.equal(nextDoc.site.theme, site.theme);
  assert.equal(nextDoc.site.contactEmail, site.contactEmail);
  assert.equal(next.files[0].content, renderSite(nextDoc.site));
  assert.equal(next.proposedHtmlSha256, sha(next.files[0].content));
  assert.equal(nextDoc.htmlSha256, next.proposedHtmlSha256);
});

test('second edit after merged revision retains first edit rather than original launch copy', async () => {
  const first = await currentEdit({patch: {tagline: 'Updated once', about: 'Changed about text.'}});
  const firstSite = JSON.parse(first.files[1].content).site;
  const afterMerge = source({
    baseCommitSha: 'e'.repeat(40),
    homepageGitBlobSha: 'f'.repeat(40),
    html: first.files[0].content,
    homepageHtmlSha256: first.proposedHtmlSha256
  });
  const second = await currentEdit({
    src: afterMerge, raw: first.files[1].content,
    ev: evidence(true, {refCommitSha: afterMerge.baseCommitSha, blobSha: '1'.repeat(40)}),
    patch: {services: ['Photography and design']}
  });
  const secondSite = JSON.parse(second.files[1].content).site;
  assert.equal(secondSite.tagline, firstSite.tagline);
  assert.equal(secondSite.about, firstSite.about);
  assert.deepEqual(secondSite.services, ['Photography and design']);
  assert.equal(second.source.expectedBaseCommitSha, afterMerge.baseCommitSha);
  assert.notEqual(second.approvalReviewDigest, first.approvalReviewDigest);
});

test('stale sidecar HTML digest after unrelated homepage change is refused', async () => {
  const originalSidecar = (await migrated()).files[0].content;
  const altered = html.replace('Original homepage', 'Somebody changed the live source');
  await assert.rejects(currentEdit({
    raw: originalSidecar,
    src: source({html: altered, homepageHtmlSha256: sha(altered)}),
    patch: {theme: 'ocean'}
  }), rejected('sidecar_does_not_match_current_html'));
});

test('non-canonical duplicate-key, unknown-key and potentially unsafe sidecars are refused', async () => {
  const raw = (await migrated()).files[0].content;
  const bad = [
    raw.replace('\n', '\r\n'), raw.trimEnd(),
    raw.replace('"version": 1,', '"version": 1,\n  "version": 1,'),
    raw.replace('"schema":', '"__proto__": {"privileged": true},\n  "schema":'),
    raw.replace('"htmlSha256":', '"token": "secret",\n  "htmlSha256":'),
    'not-json', '{',
    JSON.stringify({schema: MANAGED_CONFIG_SCHEMA, version: 2, site, htmlSha256: sha(html)}) + '\n'
  ];
  for (const text of bad) {
    await assert.rejects(currentEdit({raw: text, patch: {tagline: 'New'}}),
      rejected('sidecar_unverifiable'));
  }
});

test('sidecar must match renderer byte-for-byte, not merely claim the homepage hash', async () => {
  const raw = (await migrated()).files[0].content;
  const obj = JSON.parse(raw);
  obj.site.tagline = 'Tampered config';
  const tampered = JSON.stringify(obj, null, 2) + '\n';
  await assert.rejects(currentEdit({raw: tampered, patch: {theme: 'sunset'}}),
    rejected('sidecar_does_not_match_current_html'));
});

test('sidecar must be pinned to same current main commit and Git blob', async () => {
  for (const ev of [evidence(true, {refCommitSha: 'f'.repeat(40)}),
    evidence(true, {blobSha: 'bad'}),
    evidence(false), undefined]) {
    await assert.rejects(currentEdit({ev, patch: {tagline: 'New'}}),
      rejected('pinned_sidecar_evidence_required'));
  }
});

test('edits cannot change name, source identity, or unexpected fields', async () => {
  for (const patch of [
    {name: 'Different business'}, {repositoryId: 888}, {__proto__: null, siteId: id},
    {'__proto__': 'x'}, {tagline: 'a'.repeat(141)},
    {theme: '../../../secret'}, {contactEmail: 'javascript:alert(1)'}, [],
    null
  ]) {
    await assert.rejects(currentEdit({patch}),
      rejected('editable_patch_invalid'));
  }
});

test('empty or identical edits are no-ops with no proposed provider mutation', async () => {
  for (const patch of [{}, {tagline: site.tagline}]) {
    const result = await currentEdit({patch});
    assert.equal(result.status, 'already_current');
    assert.equal(result.files.length, 0);
    assert.equal(result.readyForProviderWrite, false);
    assert.equal(result.requiresSeparateHumanApproval, true);
  }
});

test('exact approval review digest is bound to current base and existing sidecar blob', async () => {
  const first = await currentEdit({patch: {theme: 'sunset'}});
  const changedBlob = await currentEdit({
    ev: evidence(true, {blobSha: '2'.repeat(40)}), patch: {theme: 'sunset'}
  });
  const changedBase = await currentEdit({
    src: source({baseCommitSha: 'e'.repeat(40)}),
    ev: evidence(true, {refCommitSha: 'e'.repeat(40)}),
    patch: {theme: 'sunset'}
  });
  const changedSite = await currentEdit({patch: {theme: 'graphite'}});
  for (const next of [changedBlob, changedBase, changedSite])
    assert.notEqual(first.approvalReviewDigest, next.approvalReviewDigest);
});

test('customer copy is escaped by the deterministic renderer, not trusted as HTML', async () => {
  const change = await currentEdit({patch: {tagline: '<img src=x onerror=alert(1)>'}});
  assert(change.files[0].content.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert(!change.files[0].content.includes('<img src=x'));
});

test('no plan claims auto-approved, deployed, live verified or host ready', async () => {
  const plans = [await migrated(), await currentEdit({patch: {theme: 'sunset'}})];
  for (const p of plans) {
    const json = JSON.stringify(p);
    assert.equal(p.requiresSeparateHumanApproval, true);
    assert.equal(p.readyForProviderWrite, false);
    assert.equal(p.publicationVerified, false);
    assert(!Object.hasOwn(p, 'providerToken'));
    assert(!Object.hasOwn(p, 'deployUrl'));
    assert(!Object.hasOwn(p, 'approved'));
    assert(!json.includes('PRIVATE_KEY'));
    assert(p.files.every(x => x.path === MANAGED_CONFIG_PATH ||
      x.path === 'public/index.html'));
  }
});
