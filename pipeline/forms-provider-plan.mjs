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
CREATE TABLE IF NOT EXISTS contact_submissions (
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
CREATE INDEX IF NOT EXISTS idx_contact_submissions_day
  ON contact_submissions (hostname, created_at);
CREATE INDEX IF NOT EXISTS idx_contact_submissions_gate
  ON contact_submissions (gate_approval_id, created_at);

CREATE TABLE IF NOT EXISTS turnstile_token_uses (
  token_hash TEXT PRIMARY KEY,
  hostname TEXT NOT NULL,
  used_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_turnstile_token_uses_day
  ON turnstile_token_uses (hostname, used_at);
`;

// Launch & Own's own D1 databases (onboarding, MCP bridge). A forms write may
// never target these, whatever a receipt says (asserted against wrangler config in tests).
export const PLATFORM_D1_IDS = Object.freeze([
  'b89fb8aa-67a2-49fa-b48c-584e305b5bb2', '384a87b9-8f7c-4477-acbd-29d0c5d08465']);
// The only read the owner acceptance check may send to the customer's forms D1.
export const ACCEPTANCE_SQL =
  'SELECT COUNT(*) AS n FROM contact_submissions WHERE gate_approval_id = ? AND hostname = ?';

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
const customerDb = id => UUID36.test(id || '') && !PLATFORM_D1_IDS.includes(id);

/**
 * Exact allowlist for forms mutations under one approved grant. `receipt` is the
 * persisted provisioning record for this approval, read fresh by the caller, so
 * each write is allowed only at its own step and only against the recorded
 * customer D1. Anything not listed (other paths, extra fields, other
 * names/hosts/databases, wrong module, a step already done) is refused.
 */
export async function isApprovedFormsMutation({method, path, requestBody: b, accountId, pagesProjectName,
  hostname, gate, receipt}) {
  let names;
  try { names = formsResourceNames(pagesProjectName); } catch { return false; }
  if (hostname !== pagesProjectName + '.pages.dev' || !/^[a-f0-9]{32}$/.test(accountId || '') ||
      !receipt || !GATE.test(gate?.approvalId || '') || receipt.gateApprovalId !== gate.approvalId) return false;
  const root = '/accounts/' + accountId;
  const script = root + '/workers/scripts/' + names.script;
  if (method === 'POST' && path === root + '/challenges/widgets')
    return !receipt.widgetSitekey && sameJson(b, {name: names.widget, domains: [hostname], mode: 'managed'});
  if (method === 'POST' && path === root + '/d1/database')
    return !!receipt.widgetSitekey && !receipt.databaseId && sameJson(b, {name: names.database});
  if (method === 'POST' && path === root + '/d1/database/' + receipt.databaseId + '/query')
    return customerDb(receipt.databaseId) && !receipt.schemaApplied && sameJson(b, {sql: CUSTOMER_FORM_SCHEMA_SQL});
  if (method === 'PUT' && path === script) {
    if (!customerDb(receipt.databaseId) || !receipt.schemaApplied || receipt.workerEtag ||
        Object.keys(b || {}).sort().join() !== 'metadata,moduleSha256' ||
        b.moduleSha256 !== await sha256(CUSTOMER_FORM_WORKER_SOURCE)) return false;
    // Limits, gate id and D1 binding must be exactly the live gate and recorded database.
    return sameJson(b.metadata, metadata({hostname, databaseId: receipt.databaseId, secret: REDACTED,
      maxBodyBytes: gate.maxBodyBytes, maxSubmissionsPerDay: gate.maxSubmissionsPerDay,
      retentionDays: gate.retentionDays, gateApprovalId: gate.approvalId})) &&
      intIn(gate.maxBodyBytes, 256, 65536) && intIn(gate.maxSubmissionsPerDay, 1, 1000) &&
      intIn(gate.retentionDays, 1, 365);
  }
  if (!receipt.workerEtag || receipt.endpoint) return false;
  if (method === 'PUT' && path === script + '/schedules') return sameJson(b, [{cron: FORM_WORKER_CRON}]);
  if (method === 'POST' && path === script + '/subdomain')
    return sameJson(b, {enabled: true, previews_enabled: false});
  return false;
}

/** The owner acceptance check's only non-GET: one read query on the recorded customer D1. */
export function isApprovedFormsAcceptanceRead({method, path, requestBody: b, accountId, databaseId,
  gateApprovalId, hostname}) {
  return method === 'POST' && /^[a-f0-9]{32}$/.test(accountId || '') && customerDb(databaseId) &&
    GATE.test(gateApprovalId || '') && typeof hostname === 'string' &&
    path === '/accounts/' + accountId + '/d1/database/' + databaseId + '/query' &&
    sameJson(b, {sql: ACCEPTANCE_SQL, params: [gateApprovalId, hostname]});
}
