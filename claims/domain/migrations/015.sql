CREATE TABLE IF NOT EXISTS cw_datasets (
  id text PRIMARY KEY,
  active boolean NOT NULL,
  source_revision text NOT NULL,
  snapshot_digest text NOT NULL,
  extracted_at timestamptz NOT NULL
);
ALTER TABLE cw_items ADD COLUMN IF NOT EXISTS external_claim_number text;
ALTER TABLE cw_items ADD COLUMN IF NOT EXISTS policy_number text;
ALTER TABLE cw_items ADD COLUMN IF NOT EXISTS line_of_business text;
ALTER TABLE cw_items ADD COLUMN IF NOT EXISTS source_claim_status text;
CREATE UNIQUE INDEX IF NOT EXISTS cw_items_external_claim
  ON cw_items(tenant,profile,external_claim_number) WHERE external_claim_number IS NOT NULL;
