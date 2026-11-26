// Assistant update channel (ADR-004 option A2, owner-accepted). Runs in the customer's private assistant repo.
// PR only for security / breaking / advisory / end-of-support; fix and feature releases are a notice.
// Release class comes only from the attested, immutable release.json asset, never from editable release notes.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
export function compareVersions(a, b) {
  const x = SEMVER.exec(a), y = SEMVER.exec(b);
  if (!x || !y) throw Error('invalid_version');
  for (let i = 1; i <= 3; i++) if (Number(x[i]) !== Number(y[i])) return Number(x[i]) - Number(y[i]);
  return 0;
}

const CLASSES = new Set(['security', 'breaking', 'fix', 'feature']);
const DAY = 86400000;

/** Strict shape check for release.json. Anything unexpected makes the release unusable, never "probably fine". */
export function parseReleaseInfo(value, tag) {
  const keys = ['version', 'class', 'minSupportedFrom', 'endOfSupport'];
  if (!value || typeof value !== 'object' || Object.keys(value).some(k => !keys.includes(k))) return null;
  if (!SEMVER.test(value.version || '') || 'v' + value.version !== tag || !CLASSES.has(value.class) || !SEMVER.test(value.minSupportedFrom || '')) return null;
  const eos = value.endOfSupport;
  if (eos !== undefined && (!Array.isArray(eos) || !eos.every(e => e && SEMVER.test(e.below || '') && !Number.isNaN(Date.parse(e.date))))) return null;
  return value;
}

/**
 * releases: verified release.json objects. advisories: [{id, affectedBelow}] for the pinned upstream repo (GitHub advisory DB).
 * Returns {action: 'none' | 'notice' | 'pr', target?, reasons}.
 */
export function decideUpdate({ running, releases, advisories = [], now = Date.now() }) {
  const newer = releases.filter(r => compareVersions(r.version, running) > 0).sort((a, b) => compareVersions(a.version, b.version));
  if (!newer.length) return { action: 'none', reasons: [] };
  const latest = newer.at(-1);
  const reasons = [];
  for (const r of newer) if (r.class === 'security' || r.class === 'breaking') reasons.push(r.class + ':' + r.version);
  for (const a of advisories) if (SEMVER.test(a?.affectedBelow || '') && compareVersions(running, a.affectedBelow) < 0) reasons.push('advisory:' + a.id);
  if (compareVersions(running, latest.minSupportedFrom) < 0) reasons.push('unsupported');
  for (const e of latest.endOfSupport || []) if (compareVersions(running, e.below) < 0 && Date.parse(e.date) - now <= 90 * DAY) reasons.push('end-of-support:' + e.date);
  return { action: reasons.length ? 'pr' : 'notice', target: latest.version, reasons };
}

/**
 * Provenance gate. Every check must pass; returns {info, commitSha} or null. `run(cmd, args)` resolves to stdout or rejects.
 * Pins: upstream repo (owner/name) and its release workflow path, both from UPSTREAM.json in the customer's repo.
 */
export async function verifyRelease({ tag, tarballPath, releaseJsonPath, releaseJson, upstream, run }) {
  try {
    await run('gh', ['release', 'verify-asset', tag, tarballPath, '-R', upstream.repository]);
    await run('gh', ['release', 'verify-asset', tag, releaseJsonPath, '-R', upstream.repository]);
    const out = await run('gh', ['attestation', 'verify', tarballPath, '--repo', upstream.repository,
      '--signer-workflow', upstream.repository + '/' + upstream.signerWorkflow, '--format', 'json']);
    const info = parseReleaseInfo(releaseJson, tag);
    const commits = new Set();
    for (const item of JSON.parse(out)) {
      for (const dep of item?.verificationResult?.statement?.predicate?.buildDefinition?.resolvedDependencies || []) {
        if (/^[a-f0-9]{40}$/.test(dep?.digest?.gitCommit || '')) commits.add(dep.digest.gitCommit);
      }
    }
    return info && commits.size === 1 ? { info, commitSha: [...commits][0] } : null;
  } catch {
    return null; // any failed verification: no PR, dashboard says "update could not be verified"
  }
}

export const runCommand = (cmd, args) => promisify(execFile)(cmd, args, { maxBuffer: 8 * 1024 * 1024 }).then(r => r.stdout);
