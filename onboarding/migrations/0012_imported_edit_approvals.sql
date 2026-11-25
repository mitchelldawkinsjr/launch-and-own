-- One row claims an imported-edit approval before any GitHub write.
CREATE TABLE onboarding_imported_edit_approvals (
  approval_id TEXT PRIMARY KEY CHECK (length(approval_id) = 32),
  repository_id INTEGER NOT NULL,
  base_commit_sha TEXT NOT NULL CHECK (length(base_commit_sha) = 40),
  artifact_digest TEXT NOT NULL CHECK (length(artifact_digest) = 64),
  owner_provider TEXT NOT NULL CHECK (owner_provider IN ('github', 'cloudflare_access')),
  owner_id TEXT NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 80),
  pull_number INTEGER,
  head_sha TEXT NOT NULL DEFAULT '',
  pull_url TEXT NOT NULL DEFAULT '',
  branch TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  UNIQUE (repository_id, base_commit_sha, artifact_digest)
);
