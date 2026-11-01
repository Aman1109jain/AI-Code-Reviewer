-- Security hardening + admin console.
--  * admin accounts, sessions, recovery codes and an append-only audit log
--  * per-user ownership of reviews (so one visitor can never read another's code)
--  * optimistic-locking version counters used by the admin transaction API
--  * integrity constraints on the values the app depends on

-- ---------------------------------------------------------------------
-- Admin accounts
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(32) NOT NULL,
  email VARCHAR(254) NOT NULL,
  password_hash TEXT NOT NULL,
  role VARCHAR(16) NOT NULL DEFAULT 'admin',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
  totp_secret_enc TEXT,
  totp_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  totp_last_step BIGINT,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  password_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMPTZ,
  created_by INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT admin_users_username_format CHECK (username ~ '^[a-z0-9][a-z0-9._-]{2,31}$'),
  CONSTRAINT admin_users_email_lower CHECK (email = lower(email)),
  CONSTRAINT admin_users_role_valid CHECK (role IN ('admin', 'superadmin'))
);
CREATE UNIQUE INDEX IF NOT EXISTS admin_users_username_key ON admin_users (username);
CREATE UNIQUE INDEX IF NOT EXISTS admin_users_email_key ON admin_users (email);

-- One row per signed-in admin browser. Only the SHA-256 of the cookie value is stored.
-- stage: password_change -> mfa_setup / mfa_pending -> active
CREATE TABLE IF NOT EXISTS admin_sessions (
  id SERIAL PRIMARY KEY,
  token_hash CHAR(64) NOT NULL UNIQUE,
  admin_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  stage VARCHAR(16) NOT NULL,
  mfa_attempts INTEGER NOT NULL DEFAULT 0,
  ip VARCHAR(64),
  user_agent VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT admin_sessions_stage_valid CHECK (stage IN ('password_change', 'mfa_setup', 'mfa_pending', 'active'))
);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_admin ON admin_sessions (admin_id);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires ON admin_sessions (expires_at);

-- Single-use MFA recovery codes (keyed hashes, never the codes themselves).
CREATE TABLE IF NOT EXISTS admin_recovery_codes (
  id SERIAL PRIMARY KEY,
  admin_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  code_hash CHAR(64) NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (admin_id, code_hash)
);

-- Append-only audit trail. No foreign key on purpose (history must outlive the account),
-- and a trigger refuses UPDATE / DELETE so the application can't rewrite history.
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id BIGSERIAL PRIMARY KEY,
  admin_id INTEGER,
  admin_username VARCHAR(32),
  action VARCHAR(64) NOT NULL,
  target VARCHAR(255),
  ip VARCHAR(64),
  details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit_log (created_at DESC);

CREATE OR REPLACE FUNCTION audit_log_is_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'admin_audit_log is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS admin_audit_log_no_change ON admin_audit_log;
CREATE TRIGGER admin_audit_log_no_change
  BEFORE UPDATE OR DELETE ON admin_audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_is_append_only();

-- ---------------------------------------------------------------------
-- Ownership + optimistic locking
-- ---------------------------------------------------------------------
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS owner_user_id INTEGER REFERENCES github_users(id) ON DELETE SET NULL;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS row_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE findings ADD COLUMN IF NOT EXISTS row_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE github_users ADD COLUMN IF NOT EXISTS row_version INTEGER NOT NULL DEFAULT 1;

-- Pull-request reviews belong to the connected user whose login owns the repo.
-- (Quick Check reviews had no owner recorded; an admin can assign them in the console.)
UPDATE reviews r
   SET owner_user_id = u.id
  FROM github_users u
 WHERE r.owner_user_id IS NULL
   AND r.repo_owner IS NOT NULL
   AND lower(r.repo_owner) = lower(u.login);

CREATE INDEX IF NOT EXISTS idx_reviews_owner_created ON reviews (owner_user_id, created_at DESC);

CREATE OR REPLACE FUNCTION bump_row_version() RETURNS trigger AS $$
BEGIN
  NEW.row_version := OLD.row_version + 1;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS reviews_row_version ON reviews;
CREATE TRIGGER reviews_row_version BEFORE UPDATE ON reviews FOR EACH ROW EXECUTE FUNCTION bump_row_version();
DROP TRIGGER IF EXISTS findings_row_version ON findings;
CREATE TRIGGER findings_row_version BEFORE UPDATE ON findings FOR EACH ROW EXECUTE FUNCTION bump_row_version();
DROP TRIGGER IF EXISTS github_users_row_version ON github_users;
CREATE TRIGGER github_users_row_version BEFORE UPDATE ON github_users FOR EACH ROW EXECUTE FUNCTION bump_row_version();

-- ---------------------------------------------------------------------
-- Integrity constraints (NOT VALID = enforced for every new/changed row without
-- failing the migration if an old row happens to break the rule)
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'findings_severity_valid') THEN
    ALTER TABLE findings ADD CONSTRAINT findings_severity_valid
      CHECK (severity IN ('blocking', 'warning', 'nitpick')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reviews_source_type_valid') THEN
    ALTER TABLE reviews ADD CONSTRAINT reviews_source_type_valid
      CHECK (source_type IN ('github_pr', 'upload', 'quick_check')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reviews_score_range') THEN
    ALTER TABLE reviews ADD CONSTRAINT reviews_score_range
      CHECK (overall_score IS NULL OR overall_score BETWEEN 0 AND 100) NOT VALID;
  END IF;
END $$;
