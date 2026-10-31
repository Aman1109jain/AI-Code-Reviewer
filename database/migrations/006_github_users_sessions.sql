-- Per-user GitHub login ("Connect GitHub" button). Replaces the old static
-- GITHUB_TOKEN in .env.
--
-- github_users: one row per GitHub account that has connected. The OAuth access
-- token is stored ENCRYPTED (AES-256-GCM, key derived from SESSION_SECRET).
-- It is kept so webhook-triggered reviews can still fetch diffs and post
-- comments when nobody has the dashboard open.
CREATE TABLE IF NOT EXISTS github_users (
  id SERIAL PRIMARY KEY,
  github_id BIGINT UNIQUE NOT NULL,
  login VARCHAR(255) NOT NULL,
  name VARCHAR(255),
  avatar_url TEXT,
  access_token_enc TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- user_sessions: one row per browser that is signed in. The browser holds a
-- random id in an httpOnly cookie; only its SHA-256 hash is stored here, so a
-- database leak can't be turned into working cookies. Sessions are long-lived
-- and sliding, so returning users are NOT asked to log in again.
CREATE TABLE IF NOT EXISTS user_sessions (
  id SERIAL PRIMARY KEY,
  session_hash CHAR(64) UNIQUE NOT NULL,
  user_id INTEGER NOT NULL REFERENCES github_users(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_sessions_expires_at ON user_sessions(expires_at);
