-- #89: keep cost/privacy gate history after the current forms consent is replaced.
-- Authorization still joins the gate to the current option ID and digest. Preserve
-- all values and the job retention foreign key while removing the mutable-ID FK.
CREATE TABLE onboarding_forms_cost_privacy_approvals_v10 (
  id TEXT PRIMARY KEY,
  forms_option_approval_id TEXT NOT NULL UNIQUE,
  job_id TEXT NOT NULL REFERENCES onboarding_launch_jobs(id) ON DELETE CASCADE,
  github_user_id INTEGER NOT NULL,
  cloudflare_account_id TEXT NOT NULL,
  pages_project_id TEXT NOT NULL,
  forms_digest TEXT NOT NULL CHECK(length(forms_digest) = 64),
  approval_digest TEXT NOT NULL CHECK(length(approval_digest) = 64),
  payload_json TEXT NOT NULL,
  retention_days INTEGER NOT NULL CHECK(retention_days BETWEEN 1 AND 365),
  max_submissions_per_day INTEGER NOT NULL
    CHECK(max_submissions_per_day BETWEEN 1 AND 1000),
  max_body_bytes INTEGER NOT NULL CHECK(max_body_bytes BETWEEN 256 AND 65536),
  operator_grant_id TEXT NOT NULL UNIQUE,
  approved_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('approved', 'revoked')),
  updated_at INTEGER NOT NULL,
  CHECK (github_user_id > 0),
  CHECK (expires_at > approved_at)
);
INSERT INTO onboarding_forms_cost_privacy_approvals_v10 (
  id, forms_option_approval_id, job_id, github_user_id, cloudflare_account_id,
  pages_project_id, forms_digest, approval_digest, payload_json, retention_days,
  max_submissions_per_day, max_body_bytes, operator_grant_id, approved_at,
  expires_at, status, updated_at
)
SELECT id, forms_option_approval_id, job_id, github_user_id, cloudflare_account_id,
       pages_project_id, forms_digest, approval_digest, payload_json, retention_days,
       max_submissions_per_day, max_body_bytes, operator_grant_id, approved_at,
       expires_at, status, updated_at
FROM onboarding_forms_cost_privacy_approvals;
DROP TABLE onboarding_forms_cost_privacy_approvals;
ALTER TABLE onboarding_forms_cost_privacy_approvals_v10 RENAME TO onboarding_forms_cost_privacy_approvals;
CREATE INDEX idx_forms_cost_privacy_owner
  ON onboarding_forms_cost_privacy_approvals
  (github_user_id, cloudflare_account_id, job_id, status);
CREATE INDEX idx_forms_cost_privacy_digest
  ON onboarding_forms_cost_privacy_approvals
  (forms_digest, pages_project_id, status);

-- #89: checkpoints for the approved Turnstile and customer D1 stages.
-- The option ID identifies the original consent snapshot. The current consent
-- row can receive a new ID on reapproval, while old receipts remain associated
-- with their original ID for reconciliation. The job owns receipt retention.
CREATE TABLE onboarding_forms_provisioning (
  forms_option_approval_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES onboarding_launch_jobs(id) ON DELETE CASCADE,
  github_user_id INTEGER NOT NULL CHECK(github_user_id > 0),
  cloudflare_account_id TEXT NOT NULL,
  gate_approval_id TEXT NOT NULL,
  widget_sitekey TEXT,
  database_id TEXT CHECK(database_id IS NULL OR length(database_id) = 36),
  schema_applied INTEGER NOT NULL DEFAULT 0 CHECK(schema_applied IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK(database_id IS NULL OR widget_sitekey IS NOT NULL),
  CHECK(schema_applied = 0 OR database_id IS NOT NULL)
);
CREATE INDEX idx_forms_provisioning_owner
  ON onboarding_forms_provisioning (github_user_id, cloudflare_account_id, job_id);
