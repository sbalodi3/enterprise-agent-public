ALTER TABLE cw_items ADD COLUMN IF NOT EXISTS lifecycle text NOT NULL DEFAULT 'open'
  CHECK (lifecycle IN ('open','closed'));
ALTER TABLE cw_chat_conversations DROP CONSTRAINT IF EXISTS cw_chat_conversations_tenant_profile_actor_subject_scope_key;
ALTER TABLE cw_chat_conversations ADD COLUMN IF NOT EXISTS scope_revision integer NOT NULL DEFAULT 1;
ALTER TABLE cw_chat_turns ADD COLUMN IF NOT EXISTS scope jsonb;
UPDATE cw_chat_turns t SET scope=c.scope FROM cw_chat_conversations c
  WHERE t.conversation_id=c.id AND t.scope IS NULL;
ALTER TABLE cw_chat_turns ALTER COLUMN scope SET NOT NULL;
CREATE INDEX IF NOT EXISTS cw_chat_owner_history ON cw_chat_conversations(tenant,profile,actor,subject,updated_at DESC);
ALTER TABLE cw_chat_conversations ADD COLUMN IF NOT EXISTS reuse_by_scope boolean NOT NULL DEFAULT true;
CREATE UNIQUE INDEX IF NOT EXISTS cw_chat_reusable_scope ON cw_chat_conversations(tenant,profile,actor,subject,scope)
  WHERE reuse_by_scope;
ALTER TABLE cw_chat_turns ADD COLUMN IF NOT EXISTS scope_revision integer NOT NULL DEFAULT 1;
