ALTER TABLE cw_items ADD COLUMN IF NOT EXISTS review_note text;
ALTER TABLE cw_effects ADD COLUMN IF NOT EXISTS applied_payload jsonb;
