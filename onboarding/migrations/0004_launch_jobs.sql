-- Additive migration for the dedicated Launch & Own onboarding D1.
-- Existing approvals remain history. They cannot enqueue provider work without reapproval.
CREATE TABLE onboarding_launch_jobs (
  id TEXT PRIMARY KEY,
  github_user_id INTEGER NOT NULL,
  github_login TEXT NOT NULL,
  cloudflare_account_id TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  site_slug TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  approved_html TEXT NOT NULL,
  approval_digest TEXT NOT NULL,
  legacy_receipt_id TEXT UNIQUE,
  status TEXT NOT NULL CHECK(status IN ('queued','pending_deployment','needs_reauthorization','failed','live')),
  approved_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  next_attempt_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  lease_id TEXT,
  lease_until INTEGER,
  error_code TEXT,
  repository_id INTEGER,
  production_branch TEXT,
  expected_commit_sha TEXT,
  pages_project_id TEXT,
  provisioned_at INTEGER,
  UNIQUE(github_user_id, site_slug),
  UNIQUE(cloudflare_account_id, site_slug),
  CHECK ((lease_id IS NULL) = (lease_until IS NULL)),
  CHECK ((repository_id IS NULL) = (expected_commit_sha IS NULL)),
  CHECK ((production_branch IS NULL) = (expected_commit_sha IS NULL)),
  CHECK ((provisioned_at IS NULL) = (pages_project_id IS NULL)),
  CHECK (status NOT IN ('pending_deployment','live') OR
    (expected_commit_sha IS NOT NULL AND provisioned_at IS NOT NULL))
);
CREATE INDEX idx_onboarding_jobs_due ON onboarding_launch_jobs(next_attempt_at, id)
  WHERE status IN ('queued','pending_deployment');
CREATE INDEX idx_onboarding_jobs_owner
  ON onboarding_launch_jobs(github_user_id, cloudflare_account_id, updated_at);
CREATE INDEX idx_onboarding_jobs_expiry ON onboarding_launch_jobs(expires_at);

-- Short-lived permission stays separate from the durable snapshot and checkpoints.
CREATE TABLE onboarding_launch_job_sessions (
  job_id TEXT PRIMARY KEY REFERENCES onboarding_launch_jobs(id) ON DELETE CASCADE,
  session_hash TEXT NOT NULL REFERENCES onboarding_sessions(id_hash) ON DELETE CASCADE,
  authorization_epoch INTEGER NOT NULL
);
CREATE INDEX idx_onboarding_job_sessions_session ON onboarding_launch_job_sessions(session_hash);

ALTER TABLE onboarding_sessions ADD COLUMN authorization_epoch INTEGER NOT NULL DEFAULT 0;
ALTER TABLE onboarding_launches ADD COLUMN job_id TEXT;
ALTER TABLE onboarding_launches ADD COLUMN legacy_receipt_id TEXT;
ALTER TABLE onboarding_launches ADD COLUMN preview_html TEXT;
CREATE INDEX idx_onboarding_launches_job ON onboarding_launches(job_id);
CREATE TRIGGER onboarding_jobs_delete_previews AFTER DELETE ON onboarding_launch_jobs
BEGIN
  DELETE FROM onboarding_launches WHERE job_id = OLD.id;
END;

-- Recover approvals interrupted between the legacy approval and receipt writes.
INSERT INTO onboarding_launch_receipts
  (id, github_user_id, github_login, cloudflare_account_id, customer_name, plan_json,
   status, approved_at, updated_at, expires_at)
SELECT l.id, s.github_user_id, l.github_login, l.cloudflare_account_id, l.customer_name,
       l.plan_json, l.status, l.approved_at, l.updated_at, l.approved_at + 2592000
FROM onboarding_launches l JOIN onboarding_sessions s ON s.id_hash = l.session_hash
WHERE l.approved_at IS NOT NULL AND l.status != 'preview' AND l.approved_at + 2592000 > unixepoch()
ON CONFLICT(id) DO NOTHING;
