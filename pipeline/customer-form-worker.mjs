// Customer-owned contact form Worker handler (#89).
// Pure request handler for a future customer Worker. Never writes onboarding D1,
// never logs Turnstile secrets/tokens, never activates from a client widget alone.
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { verifyTurnstileToken } from './turnstile-siteverify.mjs';
import {
  assertFormSubmissionLimits,
  shouldDeleteSubmission,
  submissionRetentionCutoff
} from './forms-abuse-limits.mjs';

export const CUSTOMER_FORM_D1_SCHEMA_SQL = readFileSync(
  fileURLToPath(new URL('./customer-form-d1-schema.sql', import.meta.url)),
  'utf8'
);

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HOST = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)+$/i;

function deny(code, status = 400) {
  const err = new Error(code);
  err.code = code;
  err.status = status;
  throw err;
}

function tokenHash(token) {
  return createHash('sha256').update(String(token), 'utf8').digest('hex');
}

function dayStart(nowSec) {
  return nowSec - (nowSec % 86400);
}

/**
 * Apply the customer forms schema to a dedicated DB binding.
 * Rejects anything that looks like the onboarding database.
 */
export function applyCustomerFormSchema(db, {databaseName} = {}) {
  if (!db || typeof db.exec !== 'function' && typeof db.prepare !== 'function')
    deny('customer_d1_required');
  if (typeof databaseName === 'string' &&
      /onboarding|launch-and-own-onboarding|zip.?staging/i.test(databaseName))
    deny('onboarding_d1_forbidden');
  if (typeof db.exec === 'function') db.exec(CUSTOMER_FORM_D1_SCHEMA_SQL);
  else {
    for (const stmt of CUSTOMER_FORM_D1_SCHEMA_SQL.split(';').map(s => s.trim()).filter(Boolean))
      db.prepare(stmt).run();
  }
  return Object.freeze({ok: true, schema: 'contact_submissions_v1'});
}

async function markTokenUsed(db, hostname, token, nowSec) {
  const hash = tokenHash(token);
  try {
    const result = db.prepare(
      'INSERT INTO turnstile_token_uses (token_hash, hostname, used_at) VALUES (?, ?, ?)'
    ).run(hash, hostname.toLowerCase(), nowSec);
    if (result?.changes === 0) deny('turnstile_token_reuse', 403);
  } catch (error) {
    if (/UNIQUE|constraint/i.test(String(error?.message || error)))
      deny('turnstile_token_reuse', 403);
    throw error;
  }
}

/**
 * Handle one contact-form POST against customer-owned D1 + server Siteverify.
 */
export async function handleCustomerFormSubmission({
  request,
  db,
  config,
  fetchFn = globalThis.fetch,
  nowSec = Math.floor(Date.now() / 1000)
} = {}) {
  if (!config || config.siteverifyRequired !== true)
    deny('siteverify_required', 403);
  if (typeof config.turnstileSecret !== 'string' || config.turnstileSecret.length < 8)
    deny('turnstile_secret_required', 500);
  if (typeof config.hostname !== 'string' || !HOST.test(config.hostname))
    deny('forms_hostname_required', 500);
  if (typeof config.gateApprovalId !== 'string' || config.gateApprovalId.length < 8)
    deny('cost_privacy_gate_required', 403);
  if (!db) deny('customer_d1_required', 500);

  const limits = assertFormSubmissionLimits({
    bodyBytes: 0,
    submissionsToday: 0,
    maxBodyBytes: config.maxBodyBytes,
    maxSubmissionsPerDay: config.maxSubmissionsPerDay
  });
  if (!limits.ok && limits.reason !== 'body_bytes_invalid')
    deny(limits.reason, 403);

  let form;
  try {
    form = typeof request?.formData === 'function'
      ? await request.formData()
      : request?.body;
  } catch { deny('invalid_form_body'); }
  if (!form || typeof form.get !== 'function') deny('invalid_form_body');

  // Same field rules as the deployable Worker: the site's own safe field names, bounded.
  const fields = {};
  let count = 0;
  const entries = typeof form.entries === 'function' ? [...form.entries()] : [];
  for (const [key, value] of entries) {
    if (key === 'cf-turnstile-response' || key === 'turnstileToken') continue;
    if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(key) || Object.hasOwn(fields, key)) deny('field_invalid');
    if (++count > 20) deny('too_many_fields');
    if (value.trim().length > 4000) deny('field_too_long');
    fields[key] = value.trim();
  }
  if (!Object.values(fields).some(Boolean)) deny('form_empty');
  const emailKey = Object.keys(fields).find(key => /e-?mail/i.test(key) && fields[key]);
  const email = emailKey ? fields[emailKey] : null;
  if (email !== null && (!EMAIL.test(email) || email.length > 254)) deny('email_invalid');
  const token = String(form.get('cf-turnstile-response') || form.get('turnstileToken') || '');
  const fieldsJson = JSON.stringify(fields);
  const bodyBytes = Buffer.byteLength(fieldsJson, 'utf8');
  const today = db.prepare(
    'SELECT COUNT(*) AS n FROM contact_submissions WHERE hostname = ? AND created_at >= ?'
  ).get(config.hostname.toLowerCase(), dayStart(nowSec));
  const quota = assertFormSubmissionLimits({
    bodyBytes,
    submissionsToday: Number(today?.n || 0),
    maxBodyBytes: config.maxBodyBytes,
    maxSubmissionsPerDay: config.maxSubmissionsPerDay
  });
  if (!quota.ok) deny(quota.reason, 429);

  // Consume token before trusting Siteverify success (single-use).
  await markTokenUsed(db, config.hostname, token, nowSec);
  const verified = await verifyTurnstileToken({
    secret: config.turnstileSecret,
    token,
    hostname: config.hostname,
    remoteIp: typeof request?.headers?.get === 'function'
      ? request.headers.get('cf-connecting-ip') || undefined
      : undefined,
    fetchFn,
    now: nowSec * 1000
  });

  const id = randomUUID();
  db.prepare(
    'INSERT INTO contact_submissions ' +
    '(id, hostname, gate_approval_id, fields_json, reply_email, body_bytes, turnstile_hostname, created_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    id, config.hostname.toLowerCase(), config.gateApprovalId,
    fieldsJson, email, bodyBytes, verified.hostname, nowSec
  );

  return Object.freeze({
    ok: true,
    submissionId: id,
    hostname: config.hostname.toLowerCase(),
    serverSiteverify: true,
    customerD1Bound: true,
    workingForm: true
  });
}

/** Delete personal rows older than the approved retention window. */
export function purgeExpiredCustomerFormSubmissions(db, {
  retentionDays, nowSec = Math.floor(Date.now() / 1000)
} = {}) {
  const cutoff = submissionRetentionCutoff({retentionDays, nowSec});
  const expired = db.prepare(
    'SELECT id, created_at FROM contact_submissions WHERE created_at < ?'
  ).all(cutoff);
  const deleted = [];
  for (const row of expired) {
    if (shouldDeleteSubmission({createdAt: row.created_at, retentionDays, nowSec})) {
      db.prepare('DELETE FROM contact_submissions WHERE id = ?').run(row.id);
      deleted.push(row.id);
    }
  }
  db.prepare('DELETE FROM turnstile_token_uses WHERE used_at < ?').run(cutoff);
  return Object.freeze({deleted: deleted.length, cutoff});
}

/**
 * Independent acceptance probe expected by approved-extension-consumer.
 * Uses an injected handler/DB — never claims live Cloudflare resources.
 */
export async function verifyCustomerFormAcceptance({
  hostname, db, config, fetchFn, sampleToken = 'tok_' + 'b'.repeat(40),
  nowSec = Math.floor(Date.now() / 1000)
} = {}) {
  if (!db) return Object.freeze({
    serverSiteverify: false, customerD1Bound: false, endToEndAccepted: false,
    reason: 'customer_d1_required'
  });
  let tables;
  try {
    tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('contact_submissions','turnstile_token_uses')"
    ).all();
  } catch {
    return Object.freeze({
      serverSiteverify: false, customerD1Bound: false, endToEndAccepted: false,
      reason: 'customer_d1_schema_missing'
    });
  }
  if (!Array.isArray(tables) || tables.length < 2) return Object.freeze({
    serverSiteverify: false, customerD1Bound: false, endToEndAccepted: false,
    reason: 'customer_d1_schema_missing'
  });

  const form = new Map([
    ['name', 'Acceptance Probe'],
    ['email', 'owner@example.net'],
    ['message', 'Launch & Own form acceptance check'],
    ['cf-turnstile-response', sampleToken]
  ]);
  try {
    const result = await handleCustomerFormSubmission({
      request: {
        formData: async () => ({get: key => form.get(key), entries: () => form.entries()}),
        headers: {get: () => null}
      },
      db,
      config: {...config, hostname, siteverifyRequired: true},
      fetchFn,
      nowSec
    });
    return Object.freeze({
      serverSiteverify: result.serverSiteverify === true,
      customerD1Bound: result.customerD1Bound === true,
      endToEndAccepted: result.ok === true,
      submissionId: result.submissionId
    });
  } catch (error) {
    return Object.freeze({
      serverSiteverify: false,
      customerD1Bound: true,
      endToEndAccepted: false,
      reason: error?.code || 'form_acceptance_failed'
    });
  }
}
