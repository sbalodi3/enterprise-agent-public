// Rehearse one deployment from verified immutable snapshots into a private directory and a fresh PG schema.
import pg from 'pg'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { directory } from '../auth/roster.mjs'
import { migrate,seed } from '../domain/index.mjs'
import { provisionLinks } from '../auth/identity-links.mjs'
import { createPortfolioStore } from '../portfolios/store.mjs'
import { nativeOwnership } from '../shared-chat/ownership.mjs'
import { importEmployee,rollbackEmployee } from '../shared-chat/migration.mjs'
import { inventory } from '../shared-chat/inventory.mjs'
const folder=await realpath(process.argv[2]), index=JSON.parse(await readFile(join(folder,'index.json')))
if (!process.env.CLAIMS_TEST_DATABASE_URL || index.issues.length || !['claims-demo','enterprise-agent-showcase'].includes(index.project)) throw Error('Resolve all inventory issues and set a rehearsal database URL')
const db=new pg.Pool({connectionString:process.env.CLAIMS_TEST_DATABASE_URL})
const schema='native_rehearsal_'+randomUUID().replaceAll('-','')
await db.query('CREATE SCHEMA '+schema)
const pool=new pg.Pool({connectionString:process.env.CLAIMS_TEST_DATABASE_URL,options:'-c search_path='+schema})
const stage=await mkdtemp(join(folder,'rehearsal-')),home=join(stage,'home')
const show=index.project==='enterprise-agent-showcase'
const cms=index.records.some(row=>row.principalId.startsWith('cms-')),roster=directory(show,cms)
try {
  await mkdir(home,{mode:0o700})
  await migrate(pool)
  const cmsSnapshot=cms && JSON.parse(await readFile(resolve('.artifacts/claims-showcase/cms-mcp/snapshot.json')))
  await seed(pool,{showcase:show,cmsSnapshot})
  if(show) await createPortfolioStore(pool).seed()
  await provisionLinks(pool,roster)
  const registry=await nativeOwnership(pool,roster.tenant),results=[]
  for(const record of index.records) {
    const {subject}=record
    if (!roster.employees.some(user=>user.subject===subject && user.principalId===record.principalId)) throw Error('Roster mismatch')
    const manifest=JSON.parse(await readFile(join(folder,record.manifest)))
    const legacy=join(stage,subject,'legacy'),workspace=join(stage,subject,'files'),restored=join(stage,subject,'rollback')
    for(const dest of [legacy,workspace,restored]) await mkdir(dest,{recursive:true,mode:0o700})
    execFileSync('python3',['-c',`
import sys,tarfile,pathlib,os
base=pathlib.Path(sys.argv[2]); links=[]
with tarfile.open(sys.argv[1]) as tar:
 for member in tar:
  path=pathlib.PurePosixPath(member.name)
  if path.is_absolute() or '..' in path.parts:raise ValueError('Invalid archive path')
  dst=base/path
  if member.isdir():dst.mkdir(parents=True,exist_ok=True)
  elif member.isfile() or member.islnk():
   dst.parent.mkdir(parents=True,exist_ok=True)
   with dst.open('xb') as f,tar.extractfile(member) as src:
    import shutil;shutil.copyfileobj(src,f)
  elif member.issym():links.append((dst,member.linkname))
  else:raise ValueError('Invalid archive member')
for dst,target in links:os.symlink(target,dst)
`,join(folder,'snapshots',subject+'.tar'),legacy])
    const input={legacy,workspace,home,logicalHome:home,restored,deployment:roster.tenant,manifest,registry}
    const imported=await importEmployee(input)
    await importEmployee(input)
    const result=await rollbackEmployee(input)
    const verify=await inventory(restored,subject)
    if(verify.issues.length || verify.sessionIds.join()!==manifest.sessionIds.join()) throw Error('Restored session inventory differs for '+record.principalId)
    results.push({employee:record.principalId,sessions:result.sessions.length,logs:imported.logs.length,tools:[...registry.toolsFor(subject).keys()]})
  }
  await writeFile(join(stage,'verified.json'),JSON.stringify({schema,results},null,2),{mode:0o600})
  console.log(stage,results.length,'verified employees,',results.reduce((n,row)=>n+row.sessions,0),'restored sessions')
} finally { await pool.end();await db.end() }
