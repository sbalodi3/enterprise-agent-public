import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { engineClient, workspaceManager } from './workspace-manager.mjs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openProcess } from './duplex.mjs'
import { startManager, commandService } from './manager-server.mjs'

const socket = process.env.CLAIMS_TEST_ENGINE_SOCKET
test('real engine isolates employees, shares tabs, persists files and never replays a command', { skip: !socket }, async t => {
  const engine = engineClient(socket)
  const project = 'claims-chat-test-' + randomUUID().slice(0,8), image = process.env.CLAIMS_TEST_IMAGE
  const aisha = randomUUID(), brandon = randomUUID()
  let time = 0
  const options = { engine, project, image, clock: () => time, idle: 100 }
  let manager = workspaceManager(options)
  const db = new DatabaseSync(':memory:')
  const filters = encodeURIComponent(JSON.stringify({ label: ['org.enterprise-agent.workspace=' + project] }))
  const list = (all = false) => engine('GET', '/containers/json?all=' + all + '&filters=' + filters)
  t.after(async () => {
    for (const c of await list(true)) await engine('DELETE','/containers/' + c.Id + '?force=true')
    for (const v of (await engine('GET','/volumes?filters=' + filters)).Volumes ?? [])
      await engine('DELETE','/volumes/' + v.Name)
    db.close()
  })
  await manager.reconcile()
  assert.equal(await manager.acquire(aisha, { existingOnly: true }), null)
  assert.equal((await list()).length, 0)
  const [one,two,other] = await Promise.all([manager.acquire(aisha), manager.acquire(aisha), manager.acquire(brandon)])
  assert.equal(one.id, two.id)
  assert.notEqual(one.id, other.id)
  assert.equal((await list()).length, 2)
  const run = commandService({ engine, manager, journal: db })
  const write = { subject: aisha, operation: 'write1', command: 'echo private >> letter && cat letter' }
  assert.deepEqual(await run(write), { exitCode: 0, output: 'private\n' })
  assert.deepEqual(await run(write), { exitCode: 0, output: 'private\n' })
  assert.equal((await run({ subject: brandon, operation: 'read1', command: 'test ! -f letter && id -u' })).output, '1000\n')
  await assert.rejects(run({ ...write, command: 'echo again' }), /different inputs/)
  one.release(); other.release()
  const approval = await manager.acquire(brandon, { existingOnly: true })
  time = 101
  await manager.reap()
  assert.equal((await list()).length, 2)
  approval.release()
  time += 101
  await manager.reap()
  assert.equal((await list()).length, 1)
  two.release()
  manager = workspaceManager(options)
  await manager.reconcile()
  const recovered = await manager.acquire(aisha)
  assert.equal(recovered.id, one.id)
  recovered.release()
  time += 101
  await manager.reap()
  assert.equal((await list()).length, 0)
  const temp = await mkdtemp(join(tmpdir(),'workspace-io-'))
  const path = join(temp,'manager.sock')
  const service = await startManager({path,state:temp,engineSocket:socket,engine,project,image})
  try {
    const terminal = await openProcess({kind:'terminal',subject:aisha,cols:80,rows:24,argv:['/bin/sh','-i']},path)
    let transcript=''
    terminal.output.on('data',chunk=>{transcript+=chunk.toString()})
    await terminal.write('cat letter; exit\n')
    assert.equal((await terminal.done).exitCode,0)
    assert.match(transcript,/private/)
    const proc = await openProcess({kind:'stdio',subject:brandon,argv:['sh','-c','read input; echo "answer-$input"']},path)
    let stdout=''
    proc.output.on('data',chunk=>{stdout+=chunk.toString()})
    await proc.write('stdio-check\n')
    assert.equal((await proc.done).exitCode,0)
    assert.equal(stdout,'answer-stdio-check\n')
  } finally { await service.close(); await rm(temp,{recursive:true,force:true}) }
  const after = commandService({ engine, manager, journal: db })
  assert.equal((await after({ subject: aisha, operation: 'read2', command: 'cat letter' })).output, 'private\n')
})
