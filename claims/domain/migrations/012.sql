-- The provider owns credentials. Each app has a separate user-controlled grant.
CREATE TABLE IF NOT EXISTS cw_connection_accounts (
  tenant text NOT NULL, subject text NOT NULL, provider text NOT NULL,
  account_id text NOT NULL, address text, encrypted_tokens text,
  PRIMARY KEY (tenant, subject, provider),
  UNIQUE (provider, account_id)
);
-- Existing local installations may already have the initial non-null cache column.
ALTER TABLE cw_connection_accounts ALTER COLUMN encrypted_tokens DROP NOT NULL;
CREATE TABLE IF NOT EXISTS cw_connection_grants (
  tenant text NOT NULL, subject text NOT NULL, app text NOT NULL,
  provider text NOT NULL, status text NOT NULL CHECK (status IN ('off','connected','reconnect')),
  version integer NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant, subject, app)
);
CREATE TABLE IF NOT EXISTS cw_connection_attempts (
  state_hash text PRIMARY KEY, tenant text NOT NULL, subject text NOT NULL, app text NOT NULL,
  version integer NOT NULL, session_hash text NOT NULL, encrypted_flow text NOT NULL,
  expires_at timestamptz NOT NULL,
  UNIQUE (tenant, subject, app),
  FOREIGN KEY (tenant, subject, app) REFERENCES cw_connection_grants
);
