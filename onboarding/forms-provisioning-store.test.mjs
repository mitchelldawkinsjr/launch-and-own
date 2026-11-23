import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {createD1FormsProvisioningStore} from './forms-provisioning-store.mjs';

function d1() {
  const sqlite = new DatabaseSync(':memory:', {enableForeignKeyConstraints: false}); // only 0010 under test
  sqlite.exec(readFileSync(new URL('./migrations/0010_forms_provisioning_receipts.sql', import.meta.url), 'utf8'));
  const stmt = (sql, a = []) => ({bind: (...b) => stmt(sql, b),
    first: async () => sqlite.prepare(sql).get(...a) || null, run: async () => sqlite.prepare(sql).run(...a)});
  return {prepare: sql => stmt(sql)};
}
const owner = {github_user_id: 42, cloudflare_account_id: 'a'.repeat(32)};
const ids = {optionApprovalId: 'opt-1', jobId: 'job-1'};
const DB_ID = '11111111-2222-3333-4444-555555555555';

test('forms receipts are owner-scoped, gate-bound and write-once', async () => {
  const env = {DB: d1()};
  const store = createD1FormsProvisioningStore(env, owner, ids);
  assert.equal(await store.read(), null);
  const first = await store.record({gateApprovalId: 'gate_1', widgetSitekey: 'site1'});
  assert.equal(first.widgetSitekey, 'site1');
  assert.equal((await store.record({gateApprovalId: 'gate_1', databaseId: DB_ID})).databaseId, DB_ID);
  assert.equal((await store.record({gateApprovalId: 'gate_1', schemaApplied: true})).schemaApplied, true);
  // A different provider ID for a recorded step is refused, and the original kept.
  assert.equal(await store.record({gateApprovalId: 'gate_1', databaseId: '99999999-2222-3333-4444-555555555555'}), null);
  assert.equal((await store.read()).databaseId, DB_ID);
  // Another gate cannot write to this approval's receipt.
  assert.equal(await store.record({gateApprovalId: 'gate_2', workerEtag: 'e'}), null);
  assert.equal((await store.read()).workerEtag, null);
  // Unknown fields are refused.
  assert.equal(await store.record({gateApprovalId: 'gate_1', secret: 'x'}), null);
  // Another owner sees nothing.
  const stranger = createD1FormsProvisioningStore(env, {...owner, github_user_id: 7}, ids);
  assert.equal(await stranger.read(), null);
});
