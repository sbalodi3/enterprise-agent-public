ALTER TABLE cw_wages ADD COLUMN IF NOT EXISTS trace_id text;
ALTER TABLE cw_wages ADD COLUMN IF NOT EXISTS span_id text;
