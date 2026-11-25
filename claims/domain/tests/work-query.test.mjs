import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { createDomain, migrate, seed } from '../index.mjs'
import { parseWorkQuery } from '../../runtime/work-query.mjs'
import { inboxSource, outlookIntent } from '../../ui/outlook-chat.mjs'

test('Workbench notifications take precedence over the native Outlook shortcut', () => {
  const question = 'show me my unread notificaiton from my inbox'
  assert.deepEqual(parseWorkQuery(question), {kind:'workbench',operation:'unread'})
  assert.equal(outlookIntent(question), 'other')
  assert.equal(inboxSource('What is in my inbox?'), 'ambiguous')
  assert.equal(outlookIntent('Show my unread Outlook emails'), 'mail')
  assert.equal(outlookIntent('Search my inbox for a claim number'), 'mail')
  assert.equal(parseWorkQuery('Do I have any open action items?').operation, 'actions')
  assert.equal(parseWorkQuery('Mark an action item complete'), null)
})

test('Workbench action counts preserve linked obligations and distinguish requests without completion', {
  skip: !process.env.CLAIMS_TEST_DATABASE_URL,
}, async t => {
  const connectionString = process.env.CLAIMS_TEST_DATABASE_URL
  const schema = 'work_query_' + randomUUID().replaceAll('-', '')
  const admin = new pg.Pool({connectionString})
  await admin.query('CREATE SCHEMA ' + schema)
  const pool = new pg.Pool({connectionString, options:'-c search_path=' + schema})
  t.after(async () => { await pool.end(); await admin.query('DROP SCHEMA ' + schema + ' CASCADE'); await admin.end() })
  await migrate(pool)
  await seed(pool)
  const db = createDomain(pool)
  const maya = {tenantId:'demo',profileId:'claims-v1',principalId:'maya',subject:'fixture-subject-maya'}
  const alex = {...maya,principalId:'alex',subject:'fixture-subject-alex'}
  await db.fixture(maya, {fixtureId:'calendar-change',eventId:'calendar-1'})
  const rows = [
    ['question-open','maya','question','read'],['question-answered','maya','question','answered'],
    ['peer-request','maya','request','read'],['resolved','maya','review','resolved'],
  ]
  for (const [id, recipient, kind, status] of rows) {
    await pool.query("INSERT INTO cw_mail(id,item_id,recipient,kind,summary,source,at,status) VALUES($1,'WC-101',$2,$3,$1,'Workbench',now(),$4)",[id,recipient,kind,status])
  }
  const {work} = await db.workQuery(maya,parseWorkQuery('My open action items'))
  assert.equal(work.total,3)
  assert.deepEqual(work.sections[0].items.map(item => item.id), ['WC-101','IN-201'])
  assert.ok(work.sections[0].items[0].mailId)
  assert.deepEqual(work.sections[1].items.map(item=>item.id),['question-open'])
  assert.deepEqual(work.sections[2].items.map(item=>item.id),['peer-request'])
  const inbox = () => db.workQuery(maya,parseWorkQuery('Show unread notifications'))
  assert.deepEqual(await inbox(), await inbox())
  assert.ok(!(await db.workQuery(alex,parseWorkQuery('Show unread notifications'))).work.sections[0].items.some(i=>i.itemId==='WC-101'))
  await db.acknowledge(maya,'assigned-WC-101')
  assert.ok(!(await inbox()).work.sections[0].items.some(i=>i.id==='assigned-WC-101'))
})
