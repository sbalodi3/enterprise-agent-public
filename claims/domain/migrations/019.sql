ALTER TABLE cw_wages ADD COLUMN IF NOT EXISTS send_proposal_id text UNIQUE REFERENCES cw_proposals;
ALTER TABLE cw_wages ADD COLUMN IF NOT EXISTS approved_input jsonb;
CREATE UNIQUE INDEX IF NOT EXISTS cw_pending_wage_send ON cw_proposals(item_id)
  WHERE action='request_wages' AND status='pending';
