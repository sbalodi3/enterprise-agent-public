CREATE TABLE IF NOT EXISTS cw_native_chat_preferences (
  deployment uuid NOT NULL,
  subject uuid NOT NULL,
  namespace text NOT NULL,
  revision integer NOT NULL DEFAULT 0,
  preferences jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (deployment,subject,namespace),
  FOREIGN KEY (deployment,subject) REFERENCES cw_entra_identities(entra_tenant_id,subject)
);
