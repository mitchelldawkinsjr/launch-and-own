-- OAuth 2.1 authorization server state for MCP clients (Claude, ChatGPT).
-- Only hashes of codes / refresh tokens are stored. No provider tokens here.

CREATE TABLE IF NOT EXISTS bridge_oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_name TEXT NOT NULL,
  redirect_uris_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS bridge_oauth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  subject TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE TABLE IF NOT EXISTS bridge_refresh_tokens (
  token_hash TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  client_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
