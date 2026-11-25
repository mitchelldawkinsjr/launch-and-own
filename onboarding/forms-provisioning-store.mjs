// #89: D1 receipts for forms provisioning (migration 0010). Fields are write-once:
// a step can be recorded, never rewritten to a different provider ID.
const COLUMNS = {
  widgetSitekey: 'widget_sitekey', databaseId: 'database_id', schemaApplied: 'schema_applied'
};

function toReceipt(r) {
  return r ? Object.freeze({
    gateApprovalId: r.gate_approval_id, widgetSitekey: r.widget_sitekey || null,
    databaseId: r.database_id || null, schemaApplied: r.schema_applied === 1
  }) : null;
}

/** Receipts for one owned forms approval. `current` is the verified owner session row. */
export function createD1FormsProvisioningStore(env, current, {optionApprovalId, jobId}) {
  const owner = [optionApprovalId, jobId, current.github_user_id, current.cloudflare_account_id];
  const scope = 'forms_option_approval_id = ? AND job_id = ? AND github_user_id = ? AND cloudflare_account_id = ?';
  const select = () => env.DB.prepare(
    'SELECT * FROM onboarding_forms_provisioning WHERE ' + scope).bind(...owner).first();
  return Object.freeze({
    async read() { return toReceipt(await select()); },
    async record({gateApprovalId, ...fields}) {
      const entries = Object.entries(fields);
      if (typeof gateApprovalId !== 'string' || !gateApprovalId || entries.some(([key, value]) =>
        !Object.hasOwn(COLUMNS, key) || (key === 'schemaApplied' ? value !== true :
          typeof value !== 'string' || !value))) return null;
      const time = Math.floor(Date.now() / 1000);
      await env.DB.prepare(
        'INSERT INTO onboarding_forms_provisioning (forms_option_approval_id, job_id, github_user_id, ' +
        'cloudflare_account_id, gate_approval_id, created_at, updated_at) ' +
        'SELECT id, job_id, github_user_id, cloudflare_account_id, ?, ?, ? FROM onboarding_option_approvals ' +
        "WHERE id = ? AND job_id = ? AND github_user_id = ? AND cloudflare_account_id = ? AND kind = 'forms' AND status = 'stored' " +
        'ON CONFLICT(forms_option_approval_id) DO NOTHING')
        .bind(gateApprovalId, time, time, ...owner).run();
      const sets = [], values = [];
      for (const [key, value] of entries) {
        const column = COLUMNS[key];
        if (key === 'schemaApplied') sets.push('schema_applied = 1');
        else {
          sets.push(column + ' = COALESCE(' + column + ', ?)');
          values.push(value);
        }
      }
      if (sets.length) {
        await env.DB.prepare('UPDATE onboarding_forms_provisioning SET ' + sets.join(', ') + ', updated_at = ? ' +
          'WHERE ' + scope + ' AND gate_approval_id = ?').bind(...values, time, ...owner, gateApprovalId).run();
      }
      const saved = toReceipt(await select());
      // Refuse if the row belongs to another gate or kept a different earlier value.
      if (!saved || saved.gateApprovalId !== gateApprovalId) return null;
      for (const [key, value] of entries) if (saved[key] !== value) return null;
      return saved;
    }
  });
}
