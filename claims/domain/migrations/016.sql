-- Existing conversation.scope remains the saved manual selection. Each admitted turn
-- owns its effective scope; earlier rows retain the scope recorded at the time.
ALTER TABLE cw_chat_conversations ADD COLUMN IF NOT EXISTS focus jsonb;
ALTER TABLE cw_chat_turns ADD COLUMN IF NOT EXISTS planned boolean NOT NULL DEFAULT false;
ALTER TABLE cw_chat_turns ADD COLUMN IF NOT EXISTS time_zone text NOT NULL DEFAULT 'UTC';
ALTER TABLE cw_chat_turns ADD COLUMN IF NOT EXISTS exclusions jsonb NOT NULL DEFAULT '{}';
ALTER TABLE cw_chat_turns ADD COLUMN IF NOT EXISTS plan jsonb;
ALTER TABLE cw_chat_turns ADD COLUMN IF NOT EXISTS pending_question jsonb;
ALTER TABLE cw_chat_turns ADD COLUMN IF NOT EXISTS replies jsonb NOT NULL DEFAULT '[]';
ALTER TABLE cw_chat_turns DROP CONSTRAINT IF EXISTS cw_chat_turns_state_check;
ALTER TABLE cw_chat_turns ADD CONSTRAINT cw_chat_turns_state_check
  CHECK (state IN ('running','awaiting_input','completed','failed','cancelled'));
CREATE UNIQUE INDEX IF NOT EXISTS cw_chat_turns_open ON cw_chat_turns(conversation_id)
  WHERE state IN ('running','awaiting_input');
