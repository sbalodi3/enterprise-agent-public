-- Mail history belongs to the employee. Native workspace sessions store no mail payloads.
CREATE TABLE IF NOT EXISTS cw_mail_turns (
  tenant text NOT NULL,
  actor text NOT NULL,
  subject text NOT NULL,
  session_id text NOT NULL,
  request_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  question text NOT NULL,
  read_ref uuid,
  state text NOT NULL CHECK (state IN ('running', 'completed', 'failed')),
  version bigint NOT NULL,
  answer jsonb,
  result_refs jsonb NOT NULL DEFAULT '[]',
  PRIMARY KEY (tenant, actor, subject, session_id, request_id)
);
CREATE INDEX IF NOT EXISTS cw_mail_history ON cw_mail_turns (tenant, actor, subject, session_id, created_at DESC);
ALTER TABLE cw_mail_turns ADD COLUMN IF NOT EXISTS read_ref uuid;
