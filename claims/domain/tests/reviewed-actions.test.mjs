import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import pg from 'pg'
import {migrate,seed,createDomain} from '../index.mjs'
import {initializeJuris,jurisStore} from '../../showcase/juris/store.mjs'
import {createClaimReads} from '../../runtime/chat-mcp.mjs'
import {followups} from '../../runtime/action-intent.mjs'

test('reviewed actions on the 200-claim mock Juris portfolio',{skip:!process.env.CLAIMS_CMS_TEST_DATABASE_URL},async t=>{
  const url=new URL(process.env.CLAIMS_CMS_TEST_DATABASE_URL)
  const admin=new pg.Pool({connectionString:url.href})
  const name='reviewed_'+randomUUID().replaceAll('-','')
  await admin.query('CREATE DATABASE '+name)
  url.pathname='/'+name
  const pool=new pg.Pool({connectionString:url.href})
  t.after(async()=>{await pool.end();try{await admin.query('DROP DATABASE '+name)}finally{await admin.end()}})
  const snapshot=JSON.parse(await readFile(process.env.CLAIMS_CMS_TEST_SNAPSHOT || new URL('../../../.artifacts/claims-showcase/cms-mcp/snapshot.json',import.meta.url),'utf8'))
  await migrate(pool);await seed(pool,{showcase:true,cmsSnapshot:snapshot})
  await initializeJuris(pool,snapshot)
  const juris=jurisStore(pool)
  const requests=new Map()
  const partner=async(c,lookup)=>{
    if(!lookup)requests.set(c.requestId,{operationId:c.operationId,requestId:c.requestId,claimId:c.claimId,payloadDigest:c.payloadDigest,
      type:c.type,taskId:'task-'+c.requestId,contextId:'ctx-'+c.requestId,receiptId:'ack-'+c.requestId,appliedAt:new Date().toISOString()})
    return requests.get(c.requestId)
  }
  const domain=createDomain(pool,{showcase:{juris,partner}})
  const employee=id=>({tenantId:'demo',profileId:'claims-v1',principalId:id,subject:id})
  const owner=employee('cms-adjuster-01'),supervisor=employee('claims-admin'),other=employee('cms-adjuster-02')
  const id='CLM-000020',closed='CLM-000017'
  const view=()=>domain.availableActions(owner,id)
  const prepare=async(action,values,extra={})=>domain.prepare(owner,id,{action,values,expectedVersion:(await view()).version,...extra})
  const decide=(p,decision='approve',actor=owner)=>domain.review(actor,p.id,{decision,expectedVersion:p.version,expectedDigest:p.digest})
  const apply=async(p,actor)=>domain.dispatchOperation(await decide(p,'approve',actor))
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM mock_juris.claims WHERE id LIKE 'CLM-%'")).rows[0].n,200)
  await assert.rejects(domain.availableActions(other,id),{status:404})
  const closedView=await domain.availableActions(other,closed)
  assert.deepEqual(closedView.actions,['add_note'])
  await assert.rejects(domain.prepare(other,closed,{action:'add_note',values:{category:'General',text:'Filed.'},expectedVersion:1}),{status:403})
  const supplemental=await domain.prepare(other,closed,{action:'add_note',values:{category:'Supplemental',text:'Document received after closure.'},expectedVersion:1})
  assert.equal((await apply(supplemental,supervisor)).state,'confirmed')
  await assert.rejects(prepare('update_field',{field:'billingsAmount',value:'100',reason:'correction'}),{status:400})
  await assert.rejects(prepare('add_note',{category:'Contact',text:'Unverified email'}, {mailSummary:true}),{status:400})

  const signal=new AbortController().signal
  const tools=createClaimReads({domain,principal:owner,scope:{kind:'claim',claimIds:[id]},requestedAction:'add_note',
    allowed:['list_claim_actions','prepare_claim_action','approve','check_action_status'],signal,reauthorize:async()=>{}})
  assert.ok(!tools.tools.some(t=>t.name==='approve'))
  const recordReads=createClaimReads({domain,principal:owner,scope:{kind:'claim',claimIds:[id]},
    requestedAction:'record',allowed:['read_juris_record'],signal,reauthorize:async()=>{}})
  assert.match((await recordReads.call('read_juris_record',{})).structuredContent.text,/Handling priority · Routine/)
  const first=await tools.call('prepare_claim_action',{action:'add_note',category:'General',text:'Reported by employer.'})
  const p=(await view()).reviews.find(v=>v.id===first.structuredContent.proposalId)
  const changed=await prepare('add_note',{category:'General',text:'Employer reports payroll is outstanding.'},{replaces:p.id})
  await assert.rejects(decide(p),{code:'proposal_closed'})
  assert.equal((await juris.read(id)).notes.length,0)
  const ops=await Promise.all([decide(changed),decide(changed)])
  assert.equal(ops[0].operationId,ops[1].operationId)
  assert.equal((await domain.dispatchOperation({...ops[0],simulateLostAck:true})).state,'unknown')
  assert.equal((await domain.reconcileOperation(ops[0])).state,'confirmed')
  assert.equal((await juris.read(id)).notes.length,1)

  const priority=await prepare('update_field',{field:'handlingPriority',value:'High',reason:'Callback overdue.'})
  const competing=await prepare('update_field',{field:'handlingPriority',value:'Urgent',reason:'Other review.'})
  assert.equal((await apply(priority,supervisor)).state,'confirmed')
  await assert.rejects(decide(competing),{status:409})
  const diary=await apply(await prepare('create_diary',{purpose:'Call employer',dueAt:'2026-11-17T16:30:00.000Z'}))
  assert.equal((await domain.chatSearch(owner,{assignedOnly:true,dueToday:true})).items.some(r=>r.id===id),true)
  await apply(await prepare('reschedule_diary',{diaryId:diary.operationId,dueAt:'2026-11-20T16:30:00.000Z'}))
  await apply(await prepare('complete_diary',{diaryId:diary.operationId,completion:'Employer returned the call.'}))
  assert.equal((await domain.detail(owner,id)).item.dueAt,null)
  const rejected=await prepare('add_note',{category:'Contact',text:'Discard this draft.'})
  await decide(rejected,'reject')
  assert.equal((await juris.read(id)).notes.length,1)
  const mailTurn=randomUUID()
  await pool.query(`INSERT INTO cw_mail_turns(tenant,actor,subject,session_id,request_id,attempt_id,question,state,version,answer)
    VALUES('demo',$1,$1,'private-mail',$2,$3,'Read message','completed',1,$4)`,
    [owner.principalId,mailTurn,randomUUID(),{kind:'read',text:'Private original body',items:[]}])
  const privateDraft=await prepare('add_note',{category:'Contact',text:'Reviewed contact summary.'},
    {mailSummary:true,mailRef:{session:'private-mail',turnId:mailTurn}})
  assert.ok(!(await domain.availableActions(supervisor,id)).reviews.some(p=>p.id===privateDraft.id))
  await assert.rejects(decide(privateDraft,'approve',supervisor),{status:403})
  const shared=await prepare('add_note',{category:'Contact',text:'Reviewed contact summary.'},
    {replaces:privateDraft.id,mailSummary:true,shareSummary:true})
  assert.equal((await apply(shared,supervisor)).state,'confirmed')
  const filed=(await juris.read(id)).notes.at(-1)
  assert.equal(filed.source,'Outlook email summary')
  assert.ok(!JSON.stringify(filed).includes('private-mail') && !JSON.stringify(filed).includes('Private original'))
  const send=await prepare('request_wages',{})
  assert.equal(requests.size,0)
  await assert.rejects(prepare('request_wages',{}),{code:'wage_already_open'})
  const approved=await decide(send)
  assert.equal(requests.size,0)
  assert.equal((await domain.dispatchOperation({...approved,simulateLostAck:true})).state,'unknown')
  assert.equal((await domain.reconcileOperation(approved)).state,'confirmed')
  assert.equal(requests.size,1)
  assert.equal((await juris.read(id)).wageEvidence,null)
  assert.ok(followups('Check payroll',await view()).includes('status'))
  async function verifyFiling(employee, outgoing, count) {
    const request = outgoing.payload
    const task = requests.get(request.requestId)
    const binding = {...task,workItemId:request.claimId,eventId:'wage-result:'+task.taskId}
    const date = day => new Date(Date.parse(request.values.dateRangeStart) + day*86400000).toISOString().slice(0,10)
    const payPeriods = Array.from({length:count},(_,i) => ({
      periodStart:date(i*14),periodEnd:date(i*14+13),hours:{regular:80,overtime:0},grossEarnings:{amount:'1830.00',currency:'USD'},
    }))
    const artifact = {schema:'query.wage_evidence/1.0.0/output',data:{payPeriods},
      provenance:{sourceSystem:'mock-adp',recordIds:['pay-1'],policyDecisionId:'local-test',
        asOf:'2026-11-17T13:00:00Z',payloadHash:'sha256:'+'a'.repeat(64)}}
    await domain.admitPartnerNotice(binding)
    await domain.acceptWage({...binding,artifact,signedResponseHash:'sha256:'+'b'.repeat(64)})
    const returned = await domain.availableActions(employee,request.claimId)
    assert.ok(followups('Review the wage return',returned).includes('review_wages'))
    let filing = returned.reviews.find(r=>r.action==='record_wage_evidence' && r.status==='pending')
    assert.ok(filing.payload.filing.some(line=>line.includes((count*14)+' of 364')))
    assert.ok(filing.payload.filing.some(line=>line.includes('1830.00')))
    if (count === 1) {
      const original=filing
      await apply(await prepare('update_field',{field:'nextHandlingInstruction',value:'Review returned payroll',reason:'Payroll received.'}))
      await assert.rejects(decide(original),{status:409})
      filing=(await view()).reviews.find(p=>p.action==='record_wage_evidence' && p.status==='pending')
      assert.notEqual(filing.id,original.id)
      assert.deepEqual(filing.payload.filing,original.payload.filing)
    }
    assert.equal((await juris.read(request.claimId)).wageEvidence,null)
    assert.equal((await apply(filing,employee)).state,'confirmed')
    assert.deepEqual((await juris.read(request.claimId)).wageEvidence.filing,filing.payload.filing)
  }
  await verifyFiling(owner,send,1)
  const fullId='CLM-000002'
  const fullView=await domain.availableActions(supervisor,fullId)
  const fullRequest=await domain.prepare(supervisor,fullId,{action:'request_wages',expectedVersion:fullView.version})
  assert.equal((await apply(fullRequest,supervisor)).state,'confirmed')
  await verifyFiling(supervisor,fullRequest,26)
  const afterFiling=await prepare('request_wages',{})
  await apply(afterFiling)
  const task=requests.get(afterFiling.payload.requestId)
  await domain.transfer(supervisor,id,{recipientId:other.principalId,expectedVersion:(await view()).version})
  await assert.rejects(domain.admitPartnerNotice({...task,workItemId:id,eventId:'wage-result:'+task.taskId}),{status:409})
  await assert.rejects(view(),{status:404})
  await initializeJuris(pool,snapshot);await seed(pool,{showcase:true,cmsSnapshot:snapshot})
  assert.equal((await domain.detail(other,id)).item.ownerId,other.principalId)
  const saved=await juris.read(id)
  assert.equal(saved.handlingPriority,'High')
  assert.equal(saved.diaries[0].status,'Completed')
  assert.equal(saved.notes.length,2)
})
