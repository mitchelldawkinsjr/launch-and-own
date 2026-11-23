-- #89: operator-approved forms cost/privacy ledger. Distinct from 0005 stored
-- forms consent and from 0006 execution grants. No public endpoint inserts here.
-- A browser checkbox or optional-service budget digest never creates these rows.
CREATE TABLE onboarding_forms_cost_privacy_approvals (
  id TEXT PRIMARY KEY,
  forms_option_approval_id TEXT NOT NULL UNIQUE
    REFERENCES onboarding_option_approvals(id) ON DELETE CASCADE,
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
CREATE INDEX idx_forms_cost_privacy_owner
  ON onboarding_forms_cost_privacy_approvals
  (github_user_id, cloudflare_account_id, job_id, status);
CREATE INDEX idx_forms_cost_privacy_digest
  ON onboarding_forms_cost_privacy_approvals
  (forms_digest, pages_project_id, status);
