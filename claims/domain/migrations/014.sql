CREATE TABLE IF NOT EXISTS cw_entra_identities (
  entra_tenant_id uuid NOT NULL,
  entra_object_id uuid NOT NULL,
  tenant text NOT NULL,
  profile text NOT NULL,
  principal_id text NOT NULL,
  subject uuid NOT NULL UNIQUE,
  PRIMARY KEY (entra_tenant_id, entra_object_id),
  UNIQUE (tenant, profile, principal_id),
  FOREIGN KEY (tenant, profile, principal_id) REFERENCES cw_principals(tenant, profile, id)
);
