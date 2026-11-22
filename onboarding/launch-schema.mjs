// Compile the durable-job columns without reading customer rows.
export const LAUNCH_SCHEMA_PROBE = `SELECT j.approved_html, j.approval_digest, j.repository_id,
  j.production_branch, j.expected_commit_sha, j.pages_project_id, j.provisioned_at,
  j.attempts, j.next_attempt_at, j.lease_id, j.lease_until,
  p.job_id, p.legacy_receipt_id, p.preview_html, a.authorization_epoch, s.authorization_epoch AS session_epoch
  FROM onboarding_launch_jobs j JOIN onboarding_launch_job_sessions a ON a.job_id = j.id
  JOIN onboarding_sessions s ON s.id_hash = a.session_hash
  JOIN onboarding_launches p ON p.job_id = j.id LIMIT 0`;

export async function launchSchemaReady(db) {
  try {
    await db.prepare(LAUNCH_SCHEMA_PROBE).all();
    return true;
  } catch {
    return false;
  }
}
