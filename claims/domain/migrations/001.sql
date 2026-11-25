CREATE TABLE IF NOT EXISTS cw_principals (
 id text NOT NULL, tenant text NOT NULL, profile text NOT NULL, role text NOT NULL,
 PRIMARY KEY(tenant,profile,id)
);
CREATE TABLE IF NOT EXISTS cw_items (
 id text PRIMARY KEY, tenant text NOT NULL, profile text NOT NULL, owner_id text NOT NULL,
 type text NOT NULL, title text NOT NULL, state text NOT NULL, reason text NOT NULL,
 next_action text NOT NULL, due_at timestamptz, as_of timestamptz NOT NULL,
 source text NOT NULL, version integer NOT NULL DEFAULT 1,
 FOREIGN KEY(tenant,profile,owner_id) REFERENCES cw_principals(tenant,profile,id)
);
CREATE TABLE IF NOT EXISTS cw_evidence (
 id text PRIMARY KEY, item_id text NOT NULL REFERENCES cw_items, source text NOT NULL,
 title text NOT NULL, body text NOT NULL, as_of timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS cw_events (
 id text PRIMARY KEY, item_id text NOT NULL REFERENCES cw_items, kind text NOT NULL,
 summary text NOT NULL, at timestamptz NOT NULL, source text NOT NULL, actor text,
 subject_id text
);
CREATE TABLE IF NOT EXISTS cw_mail (
 id text PRIMARY KEY, item_id text NOT NULL REFERENCES cw_items, recipient text NOT NULL,
 kind text NOT NULL, summary text NOT NULL, source text NOT NULL,
 at timestamptz NOT NULL, status text NOT NULL DEFAULT 'unread'
);
CREATE TABLE IF NOT EXISTS cw_wages (
 request_id text PRIMARY KEY, item_id text NOT NULL REFERENCES cw_items, state text NOT NULL,
 operation_id text, event_id text, owner_id text NOT NULL, started_version integer NOT NULL
);
CREATE TABLE IF NOT EXISTS cw_fixture_deliveries (
 tenant text NOT NULL, profile text NOT NULL, event_id text NOT NULL, fixture_id text NOT NULL,
 item_id text NOT NULL REFERENCES cw_items, request_id text REFERENCES cw_wages,
 PRIMARY KEY(tenant,profile,event_id)
);
CREATE TABLE IF NOT EXISTS cw_proposals (
 id text PRIMARY KEY, item_id text NOT NULL REFERENCES cw_items, version integer NOT NULL,
 action text NOT NULL, status text NOT NULL, payload jsonb NOT NULL, digest text NOT NULL,
 creator text NOT NULL, reviewer text, simulate_lost_ack boolean NOT NULL,
 request_id text UNIQUE REFERENCES cw_wages
);
CREATE TABLE IF NOT EXISTS cw_operations (
 id text PRIMARY KEY, item_id text NOT NULL REFERENCES cw_items,
 proposal_id text NOT NULL UNIQUE REFERENCES cw_proposals, expected_version integer NOT NULL,
 state text NOT NULL, attestation jsonb NOT NULL, receipt_id text
);
CREATE TABLE IF NOT EXISTS cw_effects (
 operation_id text PRIMARY KEY REFERENCES cw_operations, receipt_id text NOT NULL UNIQUE,
 payload_digest text NOT NULL
);
CREATE TABLE IF NOT EXISTS cw_outbox (
 id text PRIMARY KEY, operation_id text NOT NULL UNIQUE REFERENCES cw_operations,
 kind text NOT NULL, created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS cw_decisions (
 id text PRIMARY KEY, tenant text NOT NULL, profile text NOT NULL, actor text NOT NULL,
 as_of timestamptz NOT NULL, slate jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS cw_feedback (
 decision_id text NOT NULL REFERENCES cw_decisions, item_id text NOT NULL REFERENCES cw_items,
 kind text NOT NULL, reason text NOT NULL, at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(decision_id,item_id,kind)
);
CREATE TABLE IF NOT EXISTS cw_labels (
 item_id text PRIMARY KEY REFERENCES cw_items, version integer NOT NULL, label text NOT NULL,
 reviewer text NOT NULL, basis text NOT NULL
);
CREATE INDEX IF NOT EXISTS cw_items_access ON cw_items(tenant,profile,owner_id);
CREATE INDEX IF NOT EXISTS cw_mail_recipient ON cw_mail(recipient,item_id);
CREATE TABLE IF NOT EXISTS cw_readers (
 item_id text NOT NULL REFERENCES cw_items, principal_id text NOT NULL,
 PRIMARY KEY(item_id,principal_id)
);
