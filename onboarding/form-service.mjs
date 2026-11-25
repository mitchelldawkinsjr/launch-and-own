// The site's deployed form service, recorded by an approved forms setup (migration 0013 receipts).
const WORKER = /^https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/;
const SITEKEY = /^[A-Za-z0-9_-]{8,64}$/;

/** {workerUrl, sitekey, databaseId} once the Worker, its address and schedule are all set up, else null. */
export async function readFormService(env, current, jobId) {
  const row = await env.DB.prepare(`SELECT widget_sitekey, worker_url, database_id FROM onboarding_forms_provisioning
    WHERE job_id = ? AND github_user_id = ? AND cloudflare_account_id = ? AND worker_schedule_set = 1
      AND worker_url IS NOT NULL AND widget_sitekey IS NOT NULL ORDER BY updated_at DESC LIMIT 1`)
    .bind(jobId, current.github_user_id, current.cloudflare_account_id).first().catch(() => null);
  if (!row || !WORKER.test(row.worker_url) || !SITEKEY.test(row.widget_sitekey)) return null;
  return {workerUrl: row.worker_url, sitekey: row.widget_sitekey, databaseId: row.database_id};
}
