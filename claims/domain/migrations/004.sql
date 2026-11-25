ALTER TABLE cw_mail ADD COLUMN IF NOT EXISTS obligation_event text;
CREATE UNIQUE INDEX IF NOT EXISTS cw_single_obligation ON cw_mail(item_id,obligation_event) WHERE obligation_event IS NOT NULL;
ALTER TABLE cw_decisions ADD COLUMN IF NOT EXISTS ranking text NOT NULL DEFAULT 'rules';
-- Older decision sets have no recorded display time.
ALTER TABLE cw_decisions ADD COLUMN IF NOT EXISTS recorded_at timestamptz;
CREATE TABLE IF NOT EXISTS cw_team_members(tenant text NOT NULL,profile text NOT NULL,team_id text NOT NULL,member_id text NOT NULL,PRIMARY KEY(tenant,profile,team_id,member_id));
CREATE TABLE IF NOT EXISTS cw_assessments(item_id text NOT NULL REFERENCES cw_items,version integer NOT NULL,reviewer text NOT NULL,label text NOT NULL,expected_action text,basis text NOT NULL,PRIMARY KEY(item_id,version,reviewer));
CREATE TABLE IF NOT EXISTS cw_decision_actions(decision_id text NOT NULL REFERENCES cw_decisions,item_id text NOT NULL REFERENCES cw_items,action text NOT NULL,at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(decision_id,item_id,action));
CREATE TABLE IF NOT EXISTS cw_mail_reads(mail_id text NOT NULL REFERENCES cw_mail,user_id text NOT NULL,PRIMARY KEY(mail_id,user_id));
