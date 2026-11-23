-- Expand stored option kinds for SEO and same-host redirect opt-ins (#88).
-- Rebuild required: SQLite/D1 cannot alter CHECK constraints in place.
CREATE TABLE onboarding_option_approvals_v9 (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES onboarding_launch_jobs(id) ON DELETE CASCADE,
  github_user_id INTEGER NOT NULL,
  cloudflare_account_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN (
    'domain', 'email', 'forms', 'analytics', 'pr_previews', 'seo', 'redirects'
  )),
  approval_digest TEXT NOT NULL CHECK(length(approval_digest) = 64),
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status = 'stored'),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(job_id, kind),
  CHECK (github_user_id > 0)
);
INSERT INTO onboarding_option_approvals_v9
  (id, job_id, github_user_id, cloudflare_account_id, kind, approval_digest,
   payload_json, status, created_at, updated_at)
SELECT id, job_id, github_user_id, cloudflare_account_id, kind, approval_digest,
       payload_json, status, created_at, updated_at
FROM onboarding_option_approvals;

CREATE TABLE onboarding_option_executions_v9 (
  id TEXT PRIMARY KEY,
  option_approval_id TEXT NOT NULL UNIQUE,
  job_id TEXT NOT NULL REFERENCES onboarding_launch_jobs(id) ON DELETE CASCADE,
  github_user_id INTEGER NOT NULL,
  cloudflare_account_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN (
    'domain','email','forms','analytics','pr_previews','seo','redirects'
  )),
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
INSERT INTO onboarding_option_executions_v9
  (id, option_approval_id, job_id, github_user_id, cloudflare_account_id, kind,
   approval_digest, payload_json, repository_id, pages_project_id, expected_commit_sha,
   authorization_epoch, operator_grant_id, approved_at, expires_at, status, lease_id,
   result_json, error_code, updated_at)
SELECT id, option_approval_id, job_id, github_user_id, cloudflare_account_id, kind,
       approval_digest, payload_json, repository_id, pages_project_id, expected_commit_sha,
       authorization_epoch, operator_grant_id, approved_at, expires_at, status, lease_id,
       result_json, error_code, updated_at
FROM onboarding_option_executions;

DROP TABLE onboarding_option_executions;
DROP TABLE onboarding_option_approvals;
ALTER TABLE onboarding_option_approvals_v9 RENAME TO onboarding_option_approvals;
ALTER TABLE onboarding_option_executions_v9 RENAME TO onboarding_option_executions;

CREATE INDEX idx_onboarding_option_approvals_owner
  ON onboarding_option_approvals(github_user_id, cloudflare_account_id, updated_at);
CREATE INDEX idx_onboarding_option_approvals_job
  ON onboarding_option_approvals(job_id, kind);
CREATE INDEX idx_option_executions_owner ON onboarding_option_executions
  (github_user_id, cloudflare_account_id, job_id, status);
CREATE INDEX idx_option_executions_job_kind ON onboarding_option_executions
  (job_id, kind, status);
