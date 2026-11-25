// #89 forms provider plan: deterministic resource names, the exact customer D1
// schema, the Worker review, and the exact staging requests the operator approval
// callback can authorize.
import {CUSTOMER_FORM_WORKER_MODULE, CUSTOMER_FORM_WORKER_SOURCE} from './customer-form-worker-source.mjs';

const FORM_WORKER_CRON = '17 3 * * *';
const FORM_WORKER_COMPATIBILITY_DATE = '2026-11-01';
// Must equal customer-form-d1-schema.sql byte for byte (asserted in tests); Workers cannot read files.
export const CUSTOMER_FORM_SCHEMA_SQL = `-- Customer-owned contact-form D1 schema (#89).
-- Deploy only into the customer's dedicated forms database — never the
-- Launch & Own onboarding D1, and never the platform ZIP staging store.
CREATE TABLE IF NOT EXISTS contact_submissions (
  id TEXT PRIMARY KEY,
  hostname TEXT NOT NULL,
  gate_approval_id TEXT NOT NULL,
  fields_json TEXT NOT NULL CHECK(length(fields_json) BETWEEN 2 AND 65536),
  reply_email TEXT CHECK(reply_email IS NULL OR length(reply_email) BETWEEN 3 AND 254),
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
const PROJECT = /^esp-[a-z0-9]+(?:-[a-z0-9]+)*-site$/;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const GATE = /^[A-Za-z0-9_-]{8,80}$/;
export const isCustomerFormsDatabaseId = id => typeof id === 'string' && UUID.test(id) && !PLATFORM_D1_IDS.includes(id);

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

/** Review exact code and bindings before a separately approved Worker setup. */
export async function buildFormWorkerReview({pagesProjectName, hostname, databaseId, maxBodyBytes,
  maxSubmissionsPerDay, retentionDays, gateApprovalId} = {}) {
  const {script} = formsResourceNames(pagesProjectName);
  if (hostname !== pagesProjectName + '.pages.dev' || !isCustomerFormsDatabaseId(databaseId) ||
      !intIn(maxBodyBytes, 256, 65536) || !intIn(maxSubmissionsPerDay, 1, 1000) ||
      !intIn(retentionDays, 1, 365) || !GATE.test(gateApprovalId || ''))
    throw Object.assign(new Error('form_worker_config_invalid'), {code: 'form_worker_config_invalid'});
  return Object.freeze({
    scriptName: script,
    moduleName: CUSTOMER_FORM_WORKER_MODULE,
    moduleSha256: await sha256(CUSTOMER_FORM_WORKER_SOURCE),
    compatibilityDate: FORM_WORKER_COMPATIBILITY_DATE,
    retentionCron: FORM_WORKER_CRON,
    readyForProviderWrite: false,
    bindings: Object.freeze([
      {type: 'd1', name: 'DB', id: databaseId},
      {type: 'plain_text', name: 'SITE_HOSTNAME', text: hostname},
      {type: 'plain_text', name: 'MAX_BODY_BYTES', text: String(maxBodyBytes)},
      {type: 'plain_text', name: 'MAX_SUBMISSIONS_PER_DAY', text: String(maxSubmissionsPerDay)},
      {type: 'plain_text', name: 'RETENTION_DAYS', text: String(retentionDays)},
      {type: 'plain_text', name: 'GATE_APPROVAL_ID', text: gateApprovalId},
      {type: 'secret_text', name: 'TURNSTILE_SECRET'}
    ].map(Object.freeze))
  });
}

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Exact allowlist for forms mutations under one approved grant. `receipt` is the
 * persisted provisioning record for this approval, read fresh by the caller, so
 * each write is allowed only at its own step and only against the recorded
 * customer D1. Anything not listed (other paths, extra fields, other
 * names/hosts/databases, wrong module, a step already done) is refused.
 */
export function isApprovedFormsMutation({method, path, requestBody: b, accountId, pagesProjectName,
  hostname, gate, receipt}) {
  if (method !== 'POST') return false;
  let names;
  try { names = formsResourceNames(pagesProjectName); } catch { return false; }
  if (hostname !== pagesProjectName + '.pages.dev' || !/^[a-f0-9]{32}$/.test(accountId || '') ||
      !receipt || !GATE.test(gate?.approvalId || '') || receipt.gateApprovalId !== gate.approvalId) return false;
  const root = '/accounts/' + accountId;
  if (path === root + '/challenges/widgets')
    return !receipt.widgetSitekey && sameJson(b, {name: names.widget, domains: [hostname], mode: 'managed'});
  if (path === root + '/d1/database')
    return !!receipt.widgetSitekey && !receipt.databaseId && sameJson(b, {name: names.database});
  if (path === root + '/d1/database/' + receipt.databaseId + '/query')
    return isCustomerFormsDatabaseId(receipt.databaseId) && !!receipt.widgetSitekey &&
      !receipt.schemaApplied && sameJson(b, {sql: CUSTOMER_FORM_SCHEMA_SQL});
  return false;
}
