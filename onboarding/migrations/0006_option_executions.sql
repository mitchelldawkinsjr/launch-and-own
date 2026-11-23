-- #88: second, operator-authorized execution ledger. The customer-reviewed 0005
-- row stays permanently 'stored' and is never itself permission to call providers.
-- No public endpoint inserts into this table. Approval is an out-of-band Domain
-- operator decision tied to the exact stored row, current owner session epoch,
-- immutable Pages/GitHub target and approved GitHub source SHA.
CREATE TABLE onboarding_option_executions (
  id TEXT PRIMARY KEY,
  option_approval_id TEXT NOT NULL UNIQUE,
  job_id TEXT NOT NULL REFERENCES onboarding_launch_jobs(id) ON DELETE CASCADE,
  github_user_id INTEGER NOT NULL,
  cloudflare_account_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('domain','email','forms')),
  approval_digest TEXT NOT NULL CHECK(length(approval_digest) = 64),
  payload_json TEXT NOT NULL,
  repository_id INTEGER NOT NULL CHECK(repository_id > 0),
  pages_project_id TEXT NOT NULL,
  expected_commit_sha TEXT NOT NULL CHECK(length(expected_commit_sha) = 40),
  authorization_epoch INTEGER NOT NULL,
  operator_grant_id TEXT NOT NULL UNIQUE,
  approved_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('approved','applying','applied','needs_reconciliation')),
  lease_id TEXT UNIQUE,
  result_json TEXT,
  error_code TEXT,
  updated_at INTEGER NOT NULL,
  CHECK ((status='approved' AND lease_id IS NULL) OR
         (status!='approved' AND lease_id IS NOT NULL)),
  CHECK (expires_at > approved_at)
);
CREATE INDEX idx_option_executions_owner ON onboarding_option_executions
  (github_user_id,cloudflare_account_id,job_id,status);
CREATE INDEX idx_option_executions_job_kind ON onboarding_option_executions
  (job_id,kind,status);
