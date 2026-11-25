-- Commit each trigger alongside its business record. ACK follows delivery to Temporal.
CREATE TABLE IF NOT EXISTS cw_wage_commands (
 seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, id text NOT NULL UNIQUE,
 request_id text NOT NULL REFERENCES cw_wages, kind text NOT NULL, event_id text,
 delivered_at timestamptz
);
CREATE INDEX IF NOT EXISTS cw_pending_wage_commands ON cw_wage_commands(seq) WHERE delivered_at IS NULL;
