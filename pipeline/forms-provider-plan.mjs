// #89 forms provider plan: deterministic resource names, the exact customer D1
// schema, the form Worker upload, and the exact-match rule the operator approval
// callback uses. Pure; shared by the provider adapter and option-execution-store.
import {CUSTOMER_FORM_WORKER_MODULE, CUSTOMER_FORM_WORKER_SOURCE} from './customer-form-worker-source.mjs';

export const FORM_WORKER_CRON = '17 3 * * *';
export const FORM_WORKER_COMPATIBILITY_DATE = '2026-11-01';
export const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
// Must equal customer-form-d1-schema.sql byte for byte (asserted in tests); Workers cannot read files.
export const CUSTOMER_FORM_SCHEMA_SQL = `-- Customer-owned contact-form D1 schema (#89).
-- Deploy only into the customer's dedicated forms database — never the
-- Launch & Own onboarding D1, and never the platform ZIP staging store.
CREATE TABLE contact_submissions (
  id TEXT PRIMARY KEY,
  hostname TEXT NOT NULL,
  gate_approval_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
  email TEXT NOT NULL CHECK(length(email) BETWEEN 3 AND 90),
  message TEXT NOT NULL CHECK(length(message) BETWEEN 1 AND 4000),
  body_bytes INTEGER NOT NULL CHECK(body_bytes BETWEEN 1 AND 65536),
  turnstile_hostname TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_contact_submissions_day
  ON contact_submissions (hostname, created_at);
CREATE INDEX idx_contact_submissions_gate
  ON contact_submissions (gate_approval_id, created_at);

CREATE TABLE turnstile_token_uses (
  token_hash TEXT PRIMARY KEY,
  hostname TEXT NOT NULL,
  used_at INTEGER NOT NULL
);
CREATE INDEX idx_turnstile_token_uses_day
  ON turnstile_token_uses (hostname, used_at);
`;

const PROJECT = /^esp-[a-z0-9]+(?:-[a-z0-9]+)*-site$/;
const UUID36 = /^[a-f0-9-]{36}$/;
const GATE = /^[A-Za-z0-9_-]{8,80}$/;
const REDACTED = '[redacted]';

export function formsResourceNames(pagesProjectName) {
  if (!PROJECT.test(pagesProjectName || '') || pagesProjectName.length > 58)
    throw Object.assign(new Error('owned_project_required'), {code: 'owned_project_required'});
  return Object.freeze({
    widget: 'launch-and-own-form-' + pagesProjectName,
    database: pagesProjectName + '-forms',
    script: pagesProjectName + '-form'
  });
}

async function sha256(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

const intIn = (v, lo, hi) => Number.isSafeInteger(v) && v >= lo && v <= hi;

function metadata({hostname, databaseId, secret, maxBodyBytes, maxSubmissionsPerDay, retentionDays, gateApprovalId}) {
  return {
    main_module: CUSTOMER_FORM_WORKER_MODULE,
    compatibility_date: FORM_WORKER_COMPATIBILITY_DATE,
    bindings: [
      {type: 'd1', name: 'DB', id: databaseId},
      {type: 'plain_text', name: 'SITE_HOSTNAME', text: hostname},
      {type: 'plain_text', name: 'MAX_BODY_BYTES', text: String(maxBodyBytes)},
      {type: 'plain_text', name: 'MAX_SUBMISSIONS_PER_DAY', text: String(maxSubmissionsPerDay)},
      {type: 'plain_text', name: 'RETENTION_DAYS', text: String(retentionDays)},
      {type: 'plain_text', name: 'GATE_APPROVAL_ID', text: gateApprovalId},
      {type: 'secret_text', name: 'TURNSTILE_SECRET', text: secret}
    ]
  };
}

/** Build the multipart upload plus a secret-free view for the approval callback. */
export async function formWorkerUpload(config) {
  const c = config || {};
  if (typeof c.hostname !== 'string' || !c.hostname.endsWith('.pages.dev') ||
      !UUID36.test(c.databaseId || '') || typeof c.secret !== 'string' || c.secret.length < 8 ||
      c.siteverifyUrl !== SITEVERIFY_URL || !intIn(c.maxBodyBytes, 256, 65536) ||
      !intIn(c.maxSubmissionsPerDay, 1, 1000) || !intIn(c.retentionDays, 1, 365) ||
      !GATE.test(c.gateApprovalId || ''))
    throw Object.assign(new Error('form_worker_config_invalid'), {code: 'form_worker_config_invalid'});
  const meta = metadata(c);
  const formData = new FormData();
  formData.set('metadata', new Blob([JSON.stringify(meta)], {type: 'application/json'}));
  formData.set(CUSTOMER_FORM_WORKER_MODULE, new Blob([CUSTOMER_FORM_WORKER_SOURCE],
    {type: 'application/javascript+module'}), CUSTOMER_FORM_WORKER_MODULE);
  const redacted = {...meta, bindings: meta.bindings.map(b =>
    b.type === 'secret_text' ? {...b, text: REDACTED} : b)};
  return {formData, approvalBody: {metadata: redacted, moduleSha256: await sha256(CUSTOMER_FORM_WORKER_SOURCE)}};
}

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Exact allowlist for forms mutations under one approved grant. Anything not
 * listed (other paths, extra fields, other names/hosts, wrong module) is refused.
 */
export async function isApprovedFormsMutation({method, path, requestBody: b, accountId, pagesProjectName, hostname, gate}) {
  let names;
  try { names = formsResourceNames(pagesProjectName); } catch { return false; }
  if (hostname !== pagesProjectName + '.pages.dev' || !/^[a-f0-9]{32}$/.test(accountId || '')) return false;
  const root = '/accounts/' + accountId;
  const script = root + '/workers/scripts/' + names.script;
  if (method === 'POST' && path === root + '/challenges/widgets')
    return sameJson(b, {name: names.widget, domains: [hostname], mode: 'managed'});
  if (method === 'POST' && path === root + '/d1/database')
    return sameJson(b, {name: names.database});
  if (method === 'POST' && new RegExp('^' + root + '/d1/database/[a-f0-9-]{36}/query$').test(path))
    return sameJson(b, {sql: CUSTOMER_FORM_SCHEMA_SQL});
  if (method === 'PUT' && path === script) {
    if (Object.keys(b || {}).sort().join() !== 'metadata,moduleSha256' ||
        b.moduleSha256 !== await sha256(CUSTOMER_FORM_WORKER_SOURCE)) return false;
    const m = b.metadata, by = Object.fromEntries((m?.bindings || []).map(x => [x.name, x]));
    const expected = metadata({hostname, databaseId: by.DB?.id, secret: REDACTED,
      maxBodyBytes: Number(by.MAX_BODY_BYTES?.text), maxSubmissionsPerDay: Number(by.MAX_SUBMISSIONS_PER_DAY?.text),
      retentionDays: Number(by.RETENTION_DAYS?.text), gateApprovalId: by.GATE_APPROVAL_ID?.text});
    // Limits and gate id must be exactly the live #89 cost/privacy approval.
    return sameJson(m, expected) && UUID36.test(by.DB?.id || '') && GATE.test(gate?.approvalId || '') &&
      by.GATE_APPROVAL_ID.text === gate.approvalId &&
      Number(by.MAX_BODY_BYTES.text) === gate.maxBodyBytes && intIn(gate.maxBodyBytes, 256, 65536) &&
      Number(by.MAX_SUBMISSIONS_PER_DAY.text) === gate.maxSubmissionsPerDay &&
      intIn(gate.maxSubmissionsPerDay, 1, 1000) &&
      Number(by.RETENTION_DAYS.text) === gate.retentionDays && intIn(gate.retentionDays, 1, 365);
  }
  if (method === 'PUT' && path === script + '/schedules') return sameJson(b, [{cron: FORM_WORKER_CRON}]);
  if (method === 'POST' && path === script + '/subdomain')
    return sameJson(b, {enabled: true, previews_enabled: false});
  return false;
}
