import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const IMPLEMENTATION = ['planned', 'in_pr', 'merged', 'deployed'];
const ACCESS = ['not_available', 'instructions_only', 'hosted_beta', 'external_beta', 'public'];
const VERIFICATION = ['not_tested', 'ci_only', 'owner_live', 'independent_live'];
export const REQUIRED_SURFACES = Object.freeze([
  'browser_manual', 'browser_zip', 'site_updates', 'portable_skill',
  'shared_mcp_api', 'claude_plugin', 'chatgpt_connector'
]);
const CONNECTED_AGENTS = ['claude_plugin', 'chatgpt_connector'];
const requiredProof = [
  'approved-artifact-digest', 'canonical-production-github-commit', 'public-html-digest'
];
const evidenceUrl = /^https:\/\/github\.com\/mitchelldawkinsjr\/launch-and-own\/(?:issues|pull)\/\d+(?:#issuecomment-\d+)?$/;
const own = (obj, property) => Object.prototype.hasOwnProperty.call(obj, property);
const hasString = v => typeof v === 'string' && v.trim().length > 0 && v.length <= 500;

// CI checks claims and evidence URL shape; only humans can verify the provider
// events that an evidence URL describes.
export function validateDistributionMatrix(matrix) {
  const errors = [];
  if (!matrix || typeof matrix !== 'object' || Array.isArray(matrix))
    return ['Release matrix must be an object'];
  if (matrix.schemaVersion !== 1) errors.push('Unsupported release matrix schemaVersion');
  const consent = matrix.ownerConsent;
  if (!consent || consent.mode !== 'hosted-human-explicit' ||
      consent.approvalBoundToExactArtifact !== true ||
      consent.providerCredentialsExposedToAgent !== false ||
      consent.agentMayPublishUnilaterally !== false ||
      consent.ownerIdentityValidatedServerSide !== true ||
      !Array.isArray(consent.publicationVerification) ||
      requiredProof.some(x => !consent.publicationVerification.includes(x)))
    errors.push('Shared owner consent/credential/verification safety contract is incomplete');
  const surfaces = matrix.surfaces;
  if (!surfaces || typeof surfaces !== 'object' || Array.isArray(surfaces))
    return [...errors, 'surfaces must be an object'];
  for (const id of REQUIRED_SURFACES)
    if (!own(surfaces, id)) errors.push(id + ': required distribution surface is missing');
  for (const [id, s] of Object.entries(surfaces)) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) {
      errors.push(id + ': invalid surface'); continue;
    }
    if (!hasString(s.label)) errors.push(id + ': missing safe display label');
    if (!IMPLEMENTATION.includes(s.implementation)) errors.push(id + ': unknown implementation stage');
    if (!ACCESS.includes(s.access)) errors.push(id + ': unknown access stage');
    if (!VERIFICATION.includes(s.verification)) errors.push(id + ': unknown verification stage');
    if (!Array.isArray(s.evidence) || !s.evidence.length ||
        s.evidence.some(url => typeof url !== 'string' || !evidenceUrl.test(url)))
      errors.push(id + ': evidence must link to public product-repo PRs/issues, without secrets');
    if (!Array.isArray(s.blockers) || s.blockers.some(x => !hasString(x)))
      errors.push(id + ': invalid blockers (use an array; nonempty entries)');
    if (s.implementation === 'planned' &&
        (s.access !== 'not_available' || s.verification !== 'not_tested'))
      errors.push(id + ': a planned feature cannot have beta access or verified results');
    if (['in_pr', 'merged'].includes(s.implementation) && s.access !== 'not_available' &&
        !(['portable_skill', 'claude_plugin'].includes(id) && s.implementation === 'merged' && s.access === 'instructions_only'))
      errors.push(id + ': PR or merged code does not constitute a hosted release');
    if (!['not_available', 'instructions_only'].includes(s.access) && s.implementation !== 'deployed')
      errors.push(id + ': access cannot be advertised before deployment');
    if (s.access === 'instructions_only' && (!['portable_skill', 'claude_plugin'].includes(id) ||
        !['merged', 'deployed'].includes(s.implementation) || s.verification !== 'ci_only'))
      errors.push(id + ': instructions-only distribution requires a reviewed, tested portable skill, not connected publishing');
    if (['owner_live', 'independent_live'].includes(s.verification) && s.implementation !== 'deployed')
      errors.push(id + ': live QA requires a deployed implementation');
    if (s.access === 'hosted_beta' && !['owner_live', 'independent_live'].includes(s.verification))
      errors.push(id + ': hosted beta claim requires observed owner-live or independent-live QA');
    if (['external_beta', 'public'].includes(s.access) && s.verification !== 'independent_live')
      errors.push(id + ': external/public access requires independent consenting-user QA');
    if (s.access === 'public' && (!s.releaseApproval ||
        s.releaseApproval.status !== 'approved' ||
        !evidenceUrl.test(s.releaseApproval.evidence || '')))
      errors.push(id + ': public release requires documented explicit owner approval');
  }
  for (const id of CONNECTED_AGENTS) {
    const agent = surfaces[id];
    if (!agent || ['not_available', 'instructions_only'].includes(agent.access)) continue;
    const api = surfaces.shared_mcp_api;
    if (!api || api.implementation !== 'deployed' || api.access === 'not_available')
      errors.push(id + ': connected client cannot ship without a deployed, accessible shared MCP/API');
  }
  return errors;
}

export function assertDistributionMatrix(matrix) {
  const errors = validateDistributionMatrix(matrix);
  if (errors.length) throw Error('Distribution release gates failed:\n- ' + errors.join('\n- '));
  return matrix;
}

export function renderDistributionMatrix(matrix) {
  assertDistributionMatrix(matrix);
  const out = ['| Surface | Code | Availability | Verification |', '| --- | --- | --- | --- |'];
  for (const id of REQUIRED_SURFACES) {
    const s = matrix.surfaces[id];
    out.push('| ' + s.label.replace(/\|/g, '/') + ' | ' +
      s.implementation + ' | ' + s.access + ' | ' + s.verification + ' |');
  }
  return out.join('\n');
}

export function loadDistributionMatrix(path = fileURLToPath(new URL('./release-matrix.json', import.meta.url))) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const matrix = assertDistributionMatrix(loadDistributionMatrix());
    console.log('Agent distribution claims: VALID (schema + release gates; not live-provider verification)');
    console.log(renderDistributionMatrix(matrix));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
