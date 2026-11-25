CREATE TABLE IF NOT EXISTS cw_department_answers (
  id uuid PRIMARY KEY,
  tenant text NOT NULL,
  department text NOT NULL,
  actor text NOT NULL,
  subject text NOT NULL,
  scope text NOT NULL,
  snapshot text NOT NULL,
  question text NOT NULL,
  answer jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS cw_department_answers_scope ON cw_department_answers
  (tenant, department, actor, subject, scope, snapshot, created_at DESC);
