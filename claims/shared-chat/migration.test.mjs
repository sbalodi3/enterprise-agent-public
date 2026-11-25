import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID, createHash } from 'node:crypto'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import pg from 'pg'
import { migrate, seed } from '../domain/index.mjs'
import { directory } from '../auth/roster.mjs'
import { provisionLinks } from '../auth/identity-links.mjs'
import { employeeProvider, personalModelProviders } from './model-profiles.mjs'
import { nativeOwnership } from './ownership.mjs'
import { inventory } from './inventory.mjs'
import { importEmployee, rollbackEmployee } from './migration.mjs'
import { sessionDir } from '../../packages/session/session-persistence-jsonl/lib/types/format.js'

const url = process.env.CLAIMS_TEST_DATABASE_URL
test('restartable employee import and rollback preserve private native history, evidence and post-switch work', { skip:!url }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(),'native-migration-')))
  const schema = 'chat_test_' + randomUUID().replaceAll('-','')
  const db = new pg.Pool({connectionString:url})
  await db.query('CREATE SCHEMA ' + schema)
  const pool = new pg.Pool({connectionString:url,options:'-c search_path='+schema})
  t.after(async () => { await pool.end(); await db.query('DROP SCHEMA ' + schema + ' CASCADE'); await db.end(); await rm(root,{recursive:true,force:true}) })
  await migrate(pool); await seed(pool)
  const roster = directory(false), deployment = roster.tenant
  await provisionLinks(pool,roster)
  const registry = await nativeOwnership(pool,deployment)
  const [first,second] = roster.employees
  const {subject} = first, id = randomUUID(), sessionId = 'session-' + randomUUID()
  const legacy = join(root,'legacy'), home = join(root,'shared'), workspace = join(root,'files'), restored = join(root,'rollback')
  const logicalHome='/data/harness', cwd=logicalHome+'/Documents', src = 'harness/'+subject
  async function write(path,bytes) { await mkdir(dirname(path),{recursive:true}); await writeFile(path,bytes) }
  for(const folder of [legacy,home,workspace,restored]) await mkdir(folder)
  await write(join(legacy,'harness/Documents/note.txt'),'original')
  await write(join(legacy,src,'cordis.patch.yml'),JSON.stringify([{id:'llm-pi-ai',config:{
    providers:{'claims-local':{baseURL:'http://obsolete.invalid',models:[{id:'demo',contextWindow:32768}]}}
  }}]))
  const record = {path:cwd,title:'Documents',sessionIds:[sessionId],createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}
  await write(join(legacy,src,'storages/workspace.json'),JSON.stringify({unit:{name:'workspace',version:2},global:{initialized:true,workspaceIds:[id]},tables:{workspaces:{[id]:record}}}))
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2S8AAAAASUVORK5CYII=','base64')
  const sha = createHash('sha256').update(image).digest('hex')
  const attachment = 'attachments/v1/objects/'+sha.slice(0,2)+'/'+sha
  await write(join(legacy,src,attachment),image)
  const name = 'session.v4.jsonl.zstd'
  const at = (folder,path,sid) => join(sessionDir(folder,path,sid),name)
  const data = {content:[{type:'image',attachment:{attachmentId:'sha256:'+sha,bytes:image.length,mediaType:'image/png'}}]}
  const log = (sid,dir,event) => Buffer.concat([zstdCompressSync(JSON.stringify({type:'session',version:4,id:sid,cwd:dir})+'\n'), zstdCompressSync(JSON.stringify(event)+'\n')])
  await write(at(join(legacy,src,'sessions'),cwd,sessionId),log(sessionId,cwd,{type:'user/message',seq:1,time:0,data}))
  const manifest = await inventory(legacy,subject)
  assert.deepEqual(manifest.issues,[])
  const input = {legacy,home,workspace,logicalHome,deployment,manifest,registry}
  const report = await importEmployee(input)
  assert.deepEqual(await importEmployee(input),report)
  const base = {baseURL:'http://model', models:[{id:'demo',contextWindow:8192,maxTokens:1024}]}
  const personal = await personalModelProviders(home,roster,base)
  assert.deepEqual(personal,{[employeeProvider(subject)]:{...base,models:[{...base.models[0],contextWindow:32768}]}})
  await assert.rejects(registry.bind(second.subject,'session',sessionId),/Conflicting/)
  assert.equal((await nativeOwnership(pool,deployment)).owner('session',sessionId),subject)
  assert.deepEqual(await readFile(join(home,attachment)),image)
  const [upload] = await registry.uploads(subject)
  assert.equal((await registry.upload(subject,upload.id)).reference.width,1)
  assert.equal(await registry.upload(second.subject,upload.id),undefined)
  assert.equal(await readFile(join(workspace,'note.txt'),'utf8'),'original')
  const after='session-'+randomUUID(), newCwd=report.mappings[0].logical
  await registry.bind(subject,'session',after)
  await write(at(join(home,'sessions'),newCwd,after),log(after,newCwd,{type:'user/message',seq:1,time:0,data}))
  const shared = JSON.parse(await readFile(join(home,'storages/workspace.json')))
  shared.tables.workspaces[id].sessionIds.push(after)
  await write(join(home,'storages/workspace.json'),JSON.stringify(shared))
  await write(join(workspace,'note.txt'),'updated')
  await write(join(workspace,'new.txt'),'new')
  await write(join(home,'profiles/claims-workbench/cordis.patch.yml'), JSON.stringify([
    {id:'llm-pi-ai', config:{providers:{'claims-local':base,...personal,[employeeProvider(second.subject)]:base}}}
  ]))
  assert.deepEqual((await rollbackEmployee({...input,restored})).sessions,[sessionId,after].sort())
  const restoredPatch = await readFile(join(restored,src,'cordis.patch.yml'),'utf8')
  assert.ok(restoredPatch.includes(employeeProvider(subject)))
  assert.ok(!restoredPatch.includes(employeeProvider(second.subject)))
  assert.equal(await readFile(join(restored,'harness/Documents/note.txt'),'utf8'),'updated')
  assert.equal(await readFile(join(restored,'harness/Documents/new.txt'),'utf8'),'new')
  assert.deepEqual(await readFile(join(restored,src,attachment)),image)
  const restoredLog=zstdDecompressSync(await readFile(at(join(restored,src,'sessions'),cwd,after))).toString()
  assert.equal(JSON.parse(restoredLog.split('\n')[0]).cwd,cwd)
  assert.equal(JSON.parse(restoredLog.split('\n')[1]).data.content[0].attachment.attachmentId,'sha256:'+sha)
  assert.deepEqual(await inventory(legacy,subject),manifest)
})
