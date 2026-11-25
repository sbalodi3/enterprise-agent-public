/** Drive the native approval card, worker and signed local A2A partner on disposable data. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import pg from 'pg'
import { migrate, seed, createDomain } from '../../domain/index.mjs'
import { createApi } from '../../runtime/api.mjs'
import { createJurisClient } from '../../domain/juris-client.mjs'
import { createJurisServer } from '../juris/server.mjs'
import { initializeJuris, jurisStore } from '../juris/store.mjs'
import { connectShowcase, wageDestination } from '../connections.mjs'
import { startWorker, submitClient } from '../../worker/index.mjs'

const { chromium } = createRequire(new URL('../../../apps/web/package.json',import.meta.url))('playwright')
const { CLAIMS_CMS_TEST_DATABASE_URL: dbUrl, CLAIMS_TEST_A2A_CONTEXT: context,
  CLAIMS_TEST_PYTHON: python, TEMPORAL_ADDRESS: address } = process.env

async function listen(server) {
  server.listen(0,'127.0.0.1')
  await once(server,'listening')
  return 'http://127.0.0.1:'+server.address().port
}

async function until(read, predicate, message) {
  const end = Date.now()+40000
  while (Date.now()<end) {
    const value = await read()
    if (predicate(value)) return value
    await delay(100)
  }
  assert.fail(message)
}

test('an adjuster authorizes the outbound A2A disclosure and the exact returned Juris filing in Chrome',
  {skip:!(dbUrl && context && python && address),timeout:150000},async t => {
    const cleanup=[]
    t.after(async()=>{for (const fn of cleanup.reverse()) await fn()})
    const scratch=await mkdtemp(join(tmpdir(),'juris-wages-'))
    cleanup.push(()=>rm(scratch,{recursive:true,force:true}))
    const admin=new pg.Pool({connectionString:dbUrl})
    const dbName='wage_browser_'+randomUUID().replaceAll('-','')
    await admin.query('CREATE DATABASE '+dbName)
    cleanup.push(async()=>{try {await admin.query('DROP DATABASE '+dbName)} finally {await admin.end()}})
    const database=new URL(dbUrl)
    database.pathname='/'+dbName
    const pool=new pg.Pool({connectionString:database.href})
    cleanup.push(()=>pool.end())
    const snapshot=JSON.parse(await readFile(process.env.CLAIMS_CMS_TEST_SNAPSHOT ||
      new URL('../../../.artifacts/claims-showcase/cms-mcp/snapshot.json',import.meta.url),'utf8'))
    await migrate(pool)
    await seed(pool,{showcase:true,cmsSnapshot:snapshot})
    await initializeJuris(pool,snapshot)
    async function host(server) {
      const url=await listen(server)
      cleanup.push(()=>new Promise(resolve=>server.close(resolve)))
      return url
    }
    const token=randomUUID()
    const juris=createJurisClient({url:await host(createJurisServer(jurisStore(pool),token)),token})
    const standins=[createServer(),createServer()]
    const [mockUrl,adapterUrl]=await Promise.all(standins.map(listen))
    await Promise.all(standins.map(s=>new Promise(resolve=>s.close(resolve))))
    const env={SHOWCASE_PARTNER_URL:adapterUrl,SHOWCASE_PARTNER_TOKEN:token}
    const domain=createDomain(pool,{showcase:{juris,partner:wageDestination(env)}})
    const actor={principalId:'claims-admin',tenantId:'demo',subject:'wage-test-admin',profileId:'claims-v1'}
    const csrf=randomUUID()
    const temporal={address,taskQueue:'wage-review-'+randomUUID()}
    const client=await submitClient(temporal)
    cleanup.push(()=>client.close())
    const api=createApi({domain,profile:{id:'claims-v1'},showcase:connectShowcase(domain,env),
      auth:{require(req,{write}={}) {if(write)assert.equal(req.headers['x-csrf-token'],csrf);return actor}},
      workerToken:token,workflow:async()=>client,trace:{run:(_name,fn)=>fn(randomUUID().replaceAll('-',''),'0123456789abcdef',()=>{})}})
    const origin=await host(createServer(async(req,res)=>{
      if(req.url.startsWith('/claims/') || req.url.startsWith('/api/internal/')) return api(req,res)
      if(['/action-review.mjs','/pdf-link.mjs'].includes(req.url)){
        res.writeHead(200,{'content-type':'text/javascript'}).end(await readFile(new URL('../../ui'+req.url,import.meta.url)))
        return
      }
      res.writeHead(200,{'content-type':'text/html'}).end(`<main></main><script type="module">
        import {mountActionReview} from '/action-review.mjs'
        mountActionReview(document.querySelector('main'),{claimId:new URLSearchParams(location.search).get('id'),csrf:${JSON.stringify(csrf)},workbench:true})
      </script>`)
    }))
    const serviceEnv={...process.env,PYTHONDONTWRITEBYTECODE:'1',PYTHONPATH:context+':'+join(context,'src'),
      PARTNER_DB:join(scratch,'adapter.sqlite'),MOCK_DB:join(scratch,'mock.sqlite'),AMAZON_MOCK_URL:mockUrl,
      PARTNER_CALLBACK_URL:adapterUrl+'/a2a/notifications',WORKBENCH_NOTICE_URL:origin+'/claims/integrations/showcase/partner',
      SHOWCASE_PARTNER_TOKEN:token,SHOWCASE_CALLBACK_TOKEN:randomUUID(),SHOWCASE_MOCK_CLIENT_SECRET:randomUUID()}
    for(const [module,url] of [['mock',mockUrl],['adapter',adapterUrl]]) {
      const child=spawn(python,['-m','uvicorn',module+':create_app','--factory','--host','127.0.0.1',
        '--port',new URL(url).port,'--no-access-log','--log-level','error'],{cwd:context,env:serviceEnv,stdio:['ignore','ignore','inherit']})
      cleanup.push(async()=>{if (child.exitCode===null && !child.signalCode){const done=once(child,'exit');child.kill();await done}})
      await until(()=>fetch(url+'/healthz').then(r=>r.ok,()=>false),Boolean,module+' health check')
    }
    const legacyId='legacy-'+randomUUID()
    await pool.query(`INSERT INTO cw_wages(request_id,item_id,state,owner_id,started_version,requested_by)
      VALUES($1,'CLM-000020','awaiting-partner','cms-adjuster-01',1,'cms-adjuster-01')`,[legacyId])
    assert.equal((await connectShowcase(domain,env).activity('wage/start',
      {requestId:legacyId,workItemId:'CLM-000020'})).state,'stale')
    const worker=await startWorker({...temporal,serviceToken:token,workApiUrl:origin,dispatchPollMs:100})
    cleanup.push(()=>worker.stop())
    const browser=await chromium.launch({channel:'chrome'})
    cleanup.push(()=>browser.close())
    const page=await browser.newPage()
    for(const [id,days] of [['CLM-000020',14],['CLM-000002',364]]) {
      await page.goto(origin+'/?id='+id)
      await page.getByRole('button',{name:'Prepare wage request',exact:true}).click()
      assert.ok((await domain.availableActions(actor,id)).wages.every(w=>w.state==='stale'))
      await page.getByRole('button',{name:'Approve and send wage request'}).click()
      const wages=await until(async()=>(await domain.availableActions(actor,id)).wages,
        w=>w.some(row=>row.taskId),'Partner did not acknowledge approved request')
      const {requestId}=wages.find(row=>row.taskId)
      const release=await page.request.post(origin+'/claims/api/items/'+id+'/release',
        {data:{requestId},headers:{'x-csrf-token':csrf}})
      assert.equal(release.status(),200)
      assert.equal((await release.json()).notificationDelivered,true)
      await until(async()=>(await domain.availableActions(actor,id)).reviews,
        rows=>rows.some(p=>p.action==='record_wage_evidence' && p.status==='pending'),'Signed return did not reach review')
      assert.equal((await juris.read(id)).wageEvidence,null)
      await page.getByRole('button',{name:'Refresh action status'}).click()
      const card=page.locator('article').filter({has:page.getByRole('button',{name:'Approve and file wage evidence'})})
      assert.match(await card.innerText(),new RegExp(days+' of 364 requested days'))
      await card.getByRole('button',{name:'Approve and file wage evidence'}).click()
      const saved=await until(()=>juris.read(id),r=>!!r.wageEvidence,'Approved evidence did not reach Juris')
      assert.equal(saved.receipts.length,1)
      assert.ok(saved.wageEvidence.filing.some(line=>line.includes('Record IDs:')))
      assert.ok(saved.wageEvidence.filing.some(line=>line.includes('Gross earnings')))
      assert.equal(saved.wageEvidence.requestId,requestId)
    }
  })
