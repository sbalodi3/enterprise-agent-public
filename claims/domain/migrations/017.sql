-- The Entra directory identifies the deployment even when demos reuse subject IDs.
CREATE UNIQUE INDEX IF NOT EXISTS cw_entra_directory_subject
  ON cw_entra_identities(entra_tenant_id, subject);
CREATE TABLE IF NOT EXISTS cw_native_chat_resources (
  deployment uuid NOT NULL,
  subject uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('workspace', 'session')),
  native_id text NOT NULL CHECK (length(native_id) BETWEEN 1 AND 256),
  PRIMARY KEY (deployment, kind, native_id),
  FOREIGN KEY (deployment, subject) REFERENCES cw_entra_identities(entra_tenant_id, subject)
);
CREATE INDEX IF NOT EXISTS cw_native_chat_owner ON cw_native_chat_resources(deployment, subject);
CREATE TABLE IF NOT EXISTS cw_native_chat_tools (
  deployment uuid NOT NULL,
  subject uuid NOT NULL,
  name text NOT NULL,
  configuration jsonb NOT NULL,
  PRIMARY KEY (deployment,subject,name),
  FOREIGN KEY (deployment,subject) REFERENCES cw_entra_identities(entra_tenant_id,subject)
);
CREATE TABLE IF NOT EXISTS cw_native_chat_uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deployment uuid NOT NULL, subject uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('image','file')),
  digest text NOT NULL, display_name text NOT NULL, reference jsonb NOT NULL,
  UNIQUE(deployment,subject,kind,digest,display_name),
  FOREIGN KEY(deployment,subject) REFERENCES cw_entra_identities(entra_tenant_id,subject)
);
