export const AS_OF = '2026-11-17T14:00:00.000Z'
export const PROFILE = 'claims-v1'
export const fixtureEvents = Object.freeze({
  'voice-team-intake': {
    itemId: 'IN-202',
    source: 'Voice intake',
    kind: 'intake.created',
    summary: 'Unassigned caller requested a follow-up.',
    title: 'Team intake transcript excerpt',
    body: '00:21 Caller asks for a follow-up and an examiner has not yet been assigned.',
    state: 'ready',
    next: 'Claim intake and verify details',
  },
  'voice-intake': {
    itemId: 'IN-201',
    source: 'Voice intake',
    kind: 'intake.received',
    summary: 'Caller requested a callback and supplied two possible incident dates.',
    title: 'Intake transcript excerpt',
    body: '00:12 Caller reports Monday. 00:43 Caller says the incident may have been Tuesday.',
    state: 'ready',
    next: 'Confirm incident date',
  },
  'a2a-update': {
    itemId: 'WC-102',
    source: 'Partner A2A simulator',
    kind: 'wage.evidence',
    summary: 'Synthetic partner wage artifact is ready for examiner review.',
    title: 'Wage evidence',
    body: 'Synthetic payroll statement: two pay periods; 40 hours in each. No wage determination.',
    state: 'ready',
    next: 'Compare wage evidence',
  },
  'calendar-change': {
    itemId: 'WC-101',
    source: 'Calendar simulator',
    kind: 'calendar.changed',
    summary: 'Callback window confirmed for this shift.',
    title: 'Calendar receipt',
    body: 'A synthetic callback block is available at 15:00 UTC.',
    state: 'ready',
    next: 'Prepare callback',
  },
  'jira-update': {
    itemId: 'WC-103',
    source: 'Jira simulator',
    kind: 'board.changed',
    summary: 'Linked issue requests source review.',
    title: 'Jira issue reference',
    body: 'Synthetic ticket DEMO-37 requires a review of source dates.',
    state: 'ready',
    next: 'Review source dates',
  },
  'ado-update': {
    itemId: 'WC-102',
    source: 'Azure Boards simulator',
    kind: 'board.changed',
    summary: 'Linked work item reports a dependency.',
    title: 'Azure Boards reference',
    body: 'Synthetic work item 42 is waiting for evidence review.',
    state: 'waiting',
    next: 'Check dependency',
  },
})
export async function seedPrincipals(db) {
  await db.query(`INSERT INTO cw_principals VALUES
    ('maya','demo','claims-v1','adjuster'),('alex','demo','claims-v1','adjuster'),
    ('supervisor','demo','claims-v1','supervisor'),('maya','isolation','claims-v1','adjuster'),
    ('maya','demo','legal-test-v1','reviewer'),('fixture-ingress','demo','claims-v1','fixture-service'),('claims-intake','demo','claims-v1','team') ON CONFLICT DO NOTHING`)
  await db.query(
    "INSERT INTO cw_team_members VALUES ('demo','claims-v1','claims-intake','maya'),('demo','claims-v1','claims-intake','alex'),('demo','claims-v1','claims-intake','supervisor') ON CONFLICT DO NOTHING",
  )
}

export async function seedData(db) {
  await seedPrincipals(db)
  const inserted = await db.query(
    `INSERT INTO cw_items (id,tenant,profile,owner_id,type,title,state,reason,next_action,due_at,as_of,source) VALUES
    ('WC-101','demo','claims-v1','maya','claim','Promised callback','ready','Callback deadline this shift','Prepare callback','2026-11-17 15:00Z',$1,'Diary'),
    ('WC-102','demo','claims-v1','maya','claim','Wage evidence request','waiting','Awaiting a partner response','Check partner status',null,$1,'Wage service'),
    ('WC-103','demo','claims-v1','alex','claim','Conflicting incident dates','ready','Two source dates disagree','Review source dates',null,$1,'Claim activity'),
    ('IN-201','demo','claims-v1','maya','intake','Unmatched caller intake','ready','Intake requires identity matching','Review intake',null,$1,'Intake queue'),
    ('WC-104','demo','claims-v1','alex','claim','Diary review','ready','Review due this shift','Review diary','2026-11-17 18:00Z',$1,'Diary'),
    ('TEST-ISOLATION','isolation','claims-v1','maya','claim','Restricted fixture','ready','Restricted','Review',null,$1,'Test'),
    ('TEST-MATTER','demo','legal-test-v1','maya','matter','Restricted matter','ready','Restricted','Review',null,$1,'Test') ON CONFLICT DO NOTHING RETURNING id`,
    [AS_OF],
  )
  const ids = inserted.rows.map((row) => row.id)
  await db.query(
    `INSERT INTO cw_evidence SELECT 'source-'||id,id,source,'Source note',CASE WHEN id LIKE 'TEST-%' THEN 'RESTRICTED_EVIDENCE_CANARY' ELSE 'Synthetic source. '||reason END,as_of FROM cw_items WHERE id=ANY($1::text[])`,
    [ids],
  )
  await db.query(
    `INSERT INTO cw_events (id,item_id,kind,summary,at,source) SELECT 'opened-'||id,id,'opened','Work item assigned',as_of,source FROM cw_items WHERE id=ANY($1::text[])`,
    [ids],
  )
  await db.query(
    `INSERT INTO cw_mail (id,item_id,recipient,kind,summary,source,at) SELECT 'assigned-'||id,id,owner_id,'assignment','Work item assigned',source,as_of FROM cw_items WHERE id=ANY($1::text[])`,
    [ids],
  )
  await db.query(
    `INSERT INTO cw_labels VALUES ('WC-101',1,'priority','fixture-rater','Promised callback in this shift'),('WC-102',1,'defer','fixture-rater','Partner response outstanding'),('WC-103',1,'priority','fixture-rater','Conflicting source dates'),('IN-201',1,'priority','fixture-rater','Unmatched intake needs review'),('WC-104',1,'priority','fixture-rater','Due this shift') ON CONFLICT DO NOTHING`,
  )
  await db.query(`INSERT INTO cw_assessments SELECT item_id,version,reviewer,label,
    CASE WHEN label='defer' THEN null WHEN item_id='WC-101' THEN 'prepare_review' ELSE 'inspect_evidence' END,basis FROM cw_labels ON CONFLICT DO NOTHING`)
  await db.query(
    "INSERT INTO cw_assessments VALUES('WC-103',1,'fixture-rater-2','defer',null,'Another synthetic reviewer waits for clarification') ON CONFLICT DO NOTHING",
  )
}
