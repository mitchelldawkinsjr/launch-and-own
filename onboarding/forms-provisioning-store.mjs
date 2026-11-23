// #89: D1 receipts for forms provisioning (migration 0010). Fields are write-once:
// a step can be recorded, never rewritten to a different provider ID.
const COLUMNS = {
  widgetSitekey: 'widget_sitekey', databaseId: 'database_id', schemaApplied: 'schema_applied',
  workerEtag: 'worker_etag', endpoint: 'endpoint', acceptedAt: 'accepted_at'
};

function toReceipt(r) {
  return r ? Object.freeze({
    gateApprovalId: r.gate_approval_id, widgetSitekey: r.widget_sitekey || null,
    databaseId: r.database_id || null, schemaApplied: r.schema_applied === 1,
    workerEtag: r.worker_etag || null, endpoint: r.endpoint || null, acceptedAt: r.accepted_at || null
  }) : null;
}

/** Receipts for one owned forms approval. `current` is the verified owner session row. */
export function createD1FormsProvisioningStore(env, current, {optionApprovalId, jobId}) {
  const owner = [optionApprovalId, current.github_user_id, current.cloudflare_account_id];
  const select = () => env.DB.prepare(
    'SELECT * FROM onboarding_forms_provisioning WHERE forms_option_approval_id = ? ' +
    'AND github_user_id = ? AND cloudflare_account_id = ?').bind(...owner).first();
  return Object.freeze({
    async read() { return toReceipt(await select()); },
    async record({gateApprovalId, ...fields}) {
      const time = Math.floor(Date.now() / 1000);
      await env.DB.prepare(
        'INSERT INTO onboarding_forms_provisioning (forms_option_approval_id, job_id, github_user_id, ' +
        'cloudflare_account_id, gate_approval_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT(forms_option_approval_id) DO NOTHING')
        .bind(optionApprovalId, jobId, current.github_user_id, current.cloudflare_account_id,
          gateApprovalId, time, time).run();
      const sets = [], values = [];
      for (const [key, value] of Object.entries(fields)) {
        if (!COLUMNS[key]) return null;
        sets.push(COLUMNS[key] + ' = COALESCE(' + COLUMNS[key] + ', ?)');
        values.push(key === 'schemaApplied' ? (value ? 1 : 0) : value);
      }
      if (sets.length) {
        // schema_applied defaults to 0, so COALESCE cannot gate it; set it directly.
        const sql = sets.map(x => x.startsWith('schema_applied') ? 'schema_applied = ?' : x).join(', ');
        await env.DB.prepare('UPDATE onboarding_forms_provisioning SET ' + sql + ', updated_at = ? ' +
          'WHERE forms_option_approval_id = ? AND github_user_id = ? AND cloudflare_account_id = ? ' +
          'AND gate_approval_id = ?').bind(...values, time, ...owner, gateApprovalId).run();
      }
      const saved = toReceipt(await select());
      // Refuse if the row belongs to another gate or kept a different earlier value.
      if (!saved || saved.gateApprovalId !== gateApprovalId) return null;
      for (const [key, value] of Object.entries(fields))
        if (saved[key] !== (key === 'schemaApplied' ? !!value : value)) return null;
      return saved;
    }
  });
}
