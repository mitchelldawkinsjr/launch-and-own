// Orchestrates one weekly update check inside the customer's private assistant repo (ADR-004 A2).
// Pins come from assistant/UPSTREAM.json (set at setup, changed only by owner-merged PRs).
import { mkdtemp, readFile, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareVersions, decideUpdate, runCommand, verifyRelease } from './check-update.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

// shortcut: only "< x.y.z" advisory ranges are understood; others are ignored here, but a `security`-class release still opens a PR.
export const affectedBelow = range => /^<\s*(\d+\.\d+\.\d+)$/.exec(String(range || '').trim())?.[1];

export async function updateCheck({ root = ROOT, run = runCommand, now = Date.now(), log = console.log, summary = process.env.GITHUB_STEP_SUMMARY } = {}) {
  const upstream = JSON.parse(await readFile(join(root, 'assistant/UPSTREAM.json'), 'utf8'));
  const running = (await readFile(join(root, 'assistant/VERSION'), 'utf8')).trim();
  const tags = JSON.parse(await run('gh', ['api', 'repos/' + upstream.repository + '/releases?per_page=20', '--jq', '[.[] | select(.draft == false and .prerelease == false) | .tag_name]']));
  const releases = [], verified = new Map();
  for (const tag of tags) {
    if (!/^v\d+\.\d+\.\d+$/.test(tag) || compareVersions(tag.slice(1), running) <= 0) continue;
    const dir = await mkdtemp(join(tmpdir(), 'assistant-update-'));
    await run('gh', ['release', 'download', tag, '-R', upstream.repository, '-p', 'release.json', '-p', 'assistant.tgz', '-D', dir]);
    const releaseJsonPath = join(dir, 'release.json'), tarballPath = join(dir, 'assistant.tgz');
    const ok = await verifyRelease({ tag, tarballPath, releaseJsonPath, releaseJson: JSON.parse(await readFile(releaseJsonPath, 'utf8')), upstream, run });
    if (!ok) { log('Skipping ' + tag + ': update could not be verified'); continue; }
    releases.push(ok.info); verified.set(ok.info.version, { ...ok, tarballPath });
  }
  // An unreadable advisory feed must not stop the check: security-class releases still open a PR on their own.
  const advisories = await run('gh', ['api', 'repos/' + upstream.repository + '/security-advisories?state=published', '--jq',
    '[.[] | {id: .ghsa_id, ranges: [.vulnerabilities[]?.vulnerable_version_range]}]'])
    .then(out => JSON.parse(out).flatMap(a => a.ranges.map(r => ({ id: a.id, affectedBelow: affectedBelow(r) })).filter(a => a.affectedBelow)))
    .catch(() => { log('Advisory feed unavailable; continuing without it'); return []; });
  const decision = decideUpdate({ running, releases, advisories, now });
  log(JSON.stringify(decision));
  if (decision.action === 'notice' && summary) await appendFile(summary, 'Assistant update ' + decision.target + ' is available (bug fixes or features). Apply it with scripts/update when you want.\n');
  if (decision.action !== 'pr') return decision;

  const target = verified.get(decision.target);
  const branch = 'assistant-update/' + decision.target;
  const existing = JSON.parse(await run('gh', ['pr', 'list', '--head', branch, '--state', 'all', '--json', 'number']));
  if (existing.length) return { ...decision, action: 'exists' }; // idempotent: one PR per target version
  await run('git', ['checkout', '-b', branch]);
  // Workflow files are never changed by the bot (GITHUB_TOKEN has no workflows permission; ADR-004).
  await run('tar', ['-xzf', target.tarballPath, '-C', root, '--exclude=*/.github/workflows/*', 'assistant']);
  await writeFile(join(root, 'assistant/VERSION'), decision.target + '\n');
  await writeFile(join(root, 'assistant/UPSTREAM_SHA'), target.commitSha + '\n');
  await run('git', ['add', 'assistant']);
  await run('git', ['-c', 'user.name=assistant-update', '-c', 'user.email=assistant-update@users.noreply.github.com', 'commit', '-m', 'Update assistant to ' + decision.target]);
  await run('git', ['push', 'origin', branch]);
  const label = decision.reasons.some(r => r.startsWith('security') || r.startsWith('advisory')) ? 'security' : 'breaking';
  // No --label: a fresh customer repo has no "security"/"breaking" labels and gh would fail after the push. The title carries it.
  await run('gh', ['pr', 'create', '--head', branch, '--title', 'Assistant update ' + decision.target + ' (' + label + ')', '--body',
    'Verified upstream release ' + decision.target + ' (commit ' + target.commitSha + ').\nReasons: ' + decision.reasons.join(', ') +
    '\n\nReview the diff, merge it yourself, then deploy with `npx wrangler deploy`. Checks on this PR wait for your approval.']);
  return decision;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await updateCheck();
