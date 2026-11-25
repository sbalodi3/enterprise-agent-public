-- Department records share the existing employee, work-item and mailbox access model.
CREATE TABLE IF NOT EXISTS ep_port_records (
 item_id text PRIMARY KEY REFERENCES cw_items(id),
 contents jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS ep_port_actions (
 id text PRIMARY KEY,
 item_id text NOT NULL REFERENCES ep_port_records(item_id),
 actor text NOT NULL, subject text NOT NULL, request_id text NOT NULL,
 expected_version integer NOT NULL, action text NOT NULL, payload jsonb NOT NULL,
 digest text NOT NULL, summary text NOT NULL, at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE (item_id, actor, subject, request_id)
);
CREATE TABLE IF NOT EXISTS ep_port_referrals (
 id text PRIMARY KEY,
 finance_id text NOT NULL REFERENCES ep_port_records(item_id),
 matter_id text NOT NULL REFERENCES ep_port_records(item_id),
 request_receipt text NOT NULL UNIQUE REFERENCES ep_port_actions(id),
 reply_receipt text UNIQUE REFERENCES ep_port_actions(id),
 state text NOT NULL CHECK(state IN ('queued','awaiting_legal','reply_queued','completed')),
 disposition text, reference text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX IF NOT EXISTS ep_port_one_open_referral ON ep_port_referrals(finance_id,matter_id)
 WHERE state <> 'completed';
CREATE INDEX IF NOT EXISTS ep_port_referrals_matter ON ep_port_referrals(matter_id,created_at);
-- The two fixed local destinations hold the actual filed packet or billing-review item.
CREATE TABLE IF NOT EXISTS ep_port_filed_records (
 id text PRIMARY KEY,
 approval_id text NOT NULL UNIQUE REFERENCES ep_port_actions(id),
 system_name text NOT NULL, title text NOT NULL, fields jsonb NOT NULL, sources jsonb NOT NULL,
 filed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
