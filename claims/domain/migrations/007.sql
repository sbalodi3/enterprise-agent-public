CREATE TABLE IF NOT EXISTS cw_chat_conversations (
  id text PRIMARY KEY,
  tenant text NOT NULL, profile text NOT NULL, actor text NOT NULL, subject text NOT NULL,
  scope jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant,profile,actor) REFERENCES cw_principals(tenant,profile,id),
  UNIQUE (tenant,profile,actor,subject,scope)
);

CREATE TABLE IF NOT EXISTS cw_chat_turns (
  id text PRIMARY KEY,
  conversation_id text NOT NULL REFERENCES cw_chat_conversations(id),
  request_id text NOT NULL, attempt_id text NOT NULL, question text NOT NULL,
  state text NOT NULL CHECK (state IN ('running','completed','failed')),
  dependencies jsonb NOT NULL, activity jsonb NOT NULL DEFAULT '[]',
  answer jsonb, error_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_until timestamptz NOT NULL,
  UNIQUE (conversation_id,request_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS cw_chat_turns_running ON cw_chat_turns(conversation_id) WHERE state='running';
CREATE INDEX IF NOT EXISTS cw_chat_turns_history ON cw_chat_turns(conversation_id,created_at,id);
