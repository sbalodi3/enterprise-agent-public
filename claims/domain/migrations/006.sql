-- The destination owns its claim revision and receipts. Workbench owns review evidence and dispatch intent.
CREATE TABLE IF NOT EXISTS cw_showcase_records (
 item_id text PRIMARY KEY REFERENCES cw_items, facts jsonb NOT NULL, filed_claim_id text REFERENCES cw_items
);
ALTER TABLE cw_evidence ADD COLUMN IF NOT EXISTS document jsonb;
ALTER TABLE cw_events ADD COLUMN IF NOT EXISTS evidence_id text REFERENCES cw_evidence;
ALTER TABLE cw_mail ADD COLUMN IF NOT EXISTS evidence_id text REFERENCES cw_evidence;
ALTER TABLE cw_wages ADD COLUMN IF NOT EXISTS partner_task_id text UNIQUE;
ALTER TABLE cw_wages ADD COLUMN IF NOT EXISTS partner_context_id text;
ALTER TABLE cw_wages ADD COLUMN IF NOT EXISTS artifact_id text REFERENCES cw_evidence;
CREATE TABLE IF NOT EXISTS cw_partner_notices (
 event_id text PRIMARY KEY, request_id text NOT NULL UNIQUE REFERENCES cw_wages, task_id text NOT NULL
);
CREATE TABLE IF NOT EXISTS cw_juris_intents (
 operation_id text PRIMARY KEY REFERENCES cw_operations, claim_id text NOT NULL REFERENCES cw_items,
 command jsonb NOT NULL, receipt jsonb
);
ALTER TABLE cw_wages ADD COLUMN IF NOT EXISTS requested_by text;
ALTER TABLE cw_events ADD COLUMN IF NOT EXISTS anchor_id text;
