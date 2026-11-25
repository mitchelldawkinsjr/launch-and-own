import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import {
  applyCustomerFormSchema,
  handleCustomerFormSubmission,
  purgeExpiredCustomerFormSubmissions,
  verifyCustomerFormAcceptance,
  CUSTOMER_FORM_D1_SCHEMA_SQL
} from './customer-form-worker.mjs';

const hostname = 'example.com';
const secret = '0xcustomer-turnstile-secret';
const gateApprovalId = 'f2345678-1234-4234-8234-123456789abc';
const nowSec = Math.floor(Date.parse('2026-11-22T12:00:00Z') / 1000);

function db() {
  const sqlite = new DatabaseSync(':memory:');
  applyCustomerFormSchema(sqlite, {databaseName: 'esp-fern-forms'});
  return sqlite;
}

function config(extra = {}) {
  return {
    hostname,
    turnstileSecret: secret,
    gateApprovalId,
    siteverifyRequired: true,
    maxBodyBytes: 4096,
    maxSubmissionsPerDay: 2,
    retentionDays: 30,
    ...extra
  };
}

function siteverifyOk(hostnameValue = hostname) {
  return async () => ({
    status: 200,
    async json() {
      return {
        success: true,
        hostname: hostnameValue,
        challenge_ts: '2026-11-22T11:59:50Z'
      };
    }
  });
}

function formRequest(fields) {
  const map = new Map(Object.entries(fields));
  return {
    formData: async () => ({get: key => map.get(key) ?? null, entries: () => map.entries()}),
    headers: {get: () => null}
  };
}

test('customer schema is distinct from onboarding D1 and creates required tables', () => {
  assert.match(CUSTOMER_FORM_D1_SCHEMA_SQL, /contact_submissions/);
  assert.doesNotMatch(CUSTOMER_FORM_D1_SCHEMA_SQL, /onboarding_/);
  const sqlite = new DatabaseSync(':memory:');
  assert.throws(
    () => applyCustomerFormSchema(sqlite, {databaseName: 'launch-and-own-onboarding-beta'}),
    err => err.code === 'onboarding_d1_forbidden'
  );
  applyCustomerFormSchema(sqlite, {databaseName: 'esp-fern-forms'});
  const tables = sqlite.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
  ).all().map(r => r.name);
  assert.deepEqual(tables, ['contact_submissions', 'turnstile_token_uses']);
});

test('end-to-end Siteverify + D1 store succeeds once; reused token fails closed', async () => {
  const sqlite = db();
  const token = 'tok_' + 'c'.repeat(40);
  const first = await handleCustomerFormSubmission({
    request: formRequest({
      name: 'Pat',
      email: 'pat@example.net',
      message: 'Hello from the form',
      'cf-turnstile-response': token
    }),
    db: sqlite,
    config: config(),
    fetchFn: siteverifyOk(),
    nowSec
  });
  assert.equal(first.ok, true);
  assert.equal(first.serverSiteverify, true);
  assert.equal(first.customerD1Bound, true);
  assert.equal(JSON.stringify(first).includes(secret), false);

  const rows = sqlite.prepare('SELECT reply_email AS email, gate_approval_id FROM contact_submissions').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].email, 'pat@example.net');
  assert.equal(rows[0].gate_approval_id, gateApprovalId);

  await assert.rejects(
    () => handleCustomerFormSubmission({
      request: formRequest({
        name: 'Pat',
        email: 'pat@example.net',
        message: 'Replay',
        'cf-turnstile-response': token
      }),
      db: sqlite,
      config: config(),
      fetchFn: siteverifyOk(),
      nowSec
    }),
    err => err.code === 'turnstile_token_reuse'
  );
});

test('daily quota and hostname mismatch fail before durable store', async () => {
  const sqlite = db();
  for (let i = 0; i < 2; i++) {
    await handleCustomerFormSubmission({
      request: formRequest({
        name: 'Pat',
        email: 'pat@example.net',
        message: 'msg ' + i,
        'cf-turnstile-response': 'tok_' + String(i).padStart(40, 'd')
      }),
      db: sqlite,
      config: config(),
      fetchFn: siteverifyOk(),
      nowSec
    });
  }
  await assert.rejects(
    () => handleCustomerFormSubmission({
      request: formRequest({
        name: 'Pat',
        email: 'pat@example.net',
        message: 'over quota',
        'cf-turnstile-response': 'tok_' + 'e'.repeat(40)
      }),
      db: sqlite,
      config: config(),
      fetchFn: siteverifyOk(),
      nowSec
    }),
    err => err.code === 'daily_quota_exhausted' && err.status === 429
  );

  const empty = db();
  await assert.rejects(
    () => handleCustomerFormSubmission({
      request: formRequest({
        name: 'Pat',
        email: 'pat@example.net',
        message: 'wrong host',
        'cf-turnstile-response': 'tok_' + 'f'.repeat(40)
      }),
      db: empty,
      config: config(),
      fetchFn: siteverifyOk('other.com'),
      nowSec
    }),
    err => err.code === 'turnstile_hostname_mismatch'
  );
  assert.equal(empty.prepare('SELECT COUNT(*) AS n FROM contact_submissions').get().n, 0);
});

test('retention purge deletes aged personal rows; acceptance helper matches consumer shape', async () => {
  const sqlite = db();
  sqlite.prepare(
    'INSERT INTO contact_submissions ' +
    '(id, hostname, gate_approval_id, fields_json, reply_email, body_bytes, turnstile_hostname, created_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    '11111111-1111-4111-8111-111111111111', hostname, gateApprovalId,
    '{"name":"Old","message":"aged"}', 'old@example.net', 32, hostname, nowSec - 40 * 86400
  );
  const purged = purgeExpiredCustomerFormSubmissions(sqlite, {
    retentionDays: 30, nowSec
  });
  assert.equal(purged.deleted, 1);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM contact_submissions').get().n, 0);

  const accepted = await verifyCustomerFormAcceptance({
    hostname,
    db: sqlite,
    config: config(),
    fetchFn: siteverifyOk(),
    sampleToken: 'tok_' + 'a'.repeat(40),
    nowSec
  });
  assert.equal(accepted.reason, undefined);
  assert.equal(accepted.serverSiteverify, true);
  assert.equal(accepted.customerD1Bound, true);
  assert.equal(accepted.endToEndAccepted, true);
});
