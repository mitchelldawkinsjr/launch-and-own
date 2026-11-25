-- Rate limits are maintained in the platform-owned bridge database.
-- Each route has a fixed number of keyed buckets and retains no client IP.
CREATE TABLE bridge_oauth_rate_limits (
  route TEXT NOT NULL CHECK (route IN ('register', 'authorize', 'token', 'revoke')),
  bucket INTEGER NOT NULL CHECK (bucket >= 0 AND bucket < 4096),
  window_start INTEGER NOT NULL,
  hits INTEGER NOT NULL CHECK (hits >= 1),
  PRIMARY KEY (route, bucket)
);
CREATE INDEX idx_bridge_agent_tokens_grant ON bridge_agent_tokens(subject, client_id);
CREATE INDEX idx_bridge_refresh_tokens_grant ON bridge_refresh_tokens(subject, client_id);
