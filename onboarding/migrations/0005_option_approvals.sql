-- Stored owner approvals for later optional features. Never authorizes a provider write by itself.
-- Domain / MX / Turnstile / D1 / form Worker create remain separate gated steps.
CREATE TABLE onboarding_option_approvals (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES onboarding_launch_jobs(id) ON DELETE CASCADE,
  github_user_id INTEGER NOT NULL,
  cloudflare_account_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('domain', 'email', 'forms')),
  approval_digest TEXT NOT NULL CHECK(length(approval_digest) = 64),
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status = 'stored'),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(job_id, kind),
  CHECK (github_user_id > 0)
);
CREATE INDEX idx_onboarding_option_approvals_owner
  ON onboarding_option_approvals(github_user_id, cloudflare_account_id, updated_at);
CREATE INDEX idx_onboarding_option_approvals_job
  ON onboarding_option_approvals(job_id, kind);
