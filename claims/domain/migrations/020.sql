ALTER TABLE cw_native_chat_resources ADD COLUMN IF NOT EXISTS chat_profile text NOT NULL DEFAULT 'claims'
  CHECK (chat_profile IN ('claims','finance','legal'));
ALTER TABLE cw_native_chat_resources ADD COLUMN IF NOT EXISTS department_record text;
ALTER TABLE cw_department_answers ADD COLUMN IF NOT EXISTS chat_session text;
ALTER TABLE cw_department_answers ADD COLUMN IF NOT EXISTS request_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS cw_department_chat_request
  ON cw_department_answers(tenant,department,subject,chat_session,request_id);
