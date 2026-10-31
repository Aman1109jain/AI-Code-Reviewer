-- GitHub OAuth login sessions (replaces the single static GITHUB_TOKEN model
-- for anything the dashboard does on the user's behalf).
CREATE TABLE IF NOT EXISTS github_oauth_sessions (
  id SERIAL PRIMARY KEY,
  session_token VARCHAR(128) UNIQUE NOT NULL,
  github_login VARCHAR(255) NOT NULL,
  access_token TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Which repos the app has auto-registered a webhook on, so a user can
-- "enable" a repo from the dashboard instead of adding the smee URL to each
-- repo's webhook settings by hand.
CREATE TABLE IF NOT EXISTS repo_connections (
  id SERIAL PRIMARY KEY,
  owner VARCHAR(255) NOT NULL,
  repo VARCHAR(255) NOT NULL,
  full_name VARCHAR(511) UNIQUE NOT NULL,
  webhook_id BIGINT,
  enabled BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Raw source for a quick code-check review (paste-and-review, no PR involved)
-- so "Create PR from this" can re-use the exact code the user submitted.
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS source_code TEXT;
