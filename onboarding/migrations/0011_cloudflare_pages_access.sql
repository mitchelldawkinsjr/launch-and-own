-- Optional Pages API access for an authenticated onboarding session.
-- This table never outlives the session and contains only sealed credentials.
CREATE TABLE onboarding_pages_access (
  session_hash TEXT PRIMARY KEY REFERENCES onboarding_sessions(id_hash) ON DELETE CASCADE,
  authorization_epoch INTEGER NOT NULL,
  account_id TEXT NOT NULL,
  access_id TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL CHECK (mode IN ('read', 'edit')),
  token_ct TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

ALTER TABLE onboarding_launch_job_sessions ADD COLUMN pages_access_id TEXT;

CREATE TRIGGER onboarding_clear_pages_access AFTER UPDATE OF authorization_epoch ON onboarding_sessions
WHEN OLD.authorization_epoch != NEW.authorization_epoch
BEGIN
  DELETE FROM onboarding_pages_access WHERE session_hash = OLD.id_hash;
END;
