import { request } from 'node:http'
import { mkdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { RemoteError } from '../../packages/typert/protocol/lib/index.js'
import { openProcess } from './duplex.mjs'
import { directory } from '../auth/roster.mjs'
import { chatTarget, loginHref, standardChatId } from '../auth/destinations.mjs'
import { localSelection } from './model-profiles.mjs'
import { employeeSettings } from './settings.mjs'
import { createPortfolioStore } from '../portfolios/store.mjs'
import { nativeOwnership } from './ownership.mjs'
import { handleFileUploadHttp } from '../../packages/client/file-upload/lib/index.js'

export const inject = ['claimsAuth', 'claimsDatabase', 'webServer', 'workspaceRegistry', 'sessionController', 'remoteAccess', 'fileUploads', 'typertGateway', 'terminalController', 'attachments', 'agentDefaultModel', 'llm']
export async function apply(ctx) {
  const deployment = directory(process.env.CLAIMS_SHOWCASE === '1').tenant
  const origin = process.env.CLAIMS_APP_ORIGIN
  const ownership = await nativeOwnership(ctx.claimsDatabase, deployment)
  ctx.provide('nativeChatOwnership', ownership)
  ctx.provide('personalSettings', await employeeSettings(ctx.claimsDatabase, deployment))
  ctx.effect(() => ctx.fileUploads.observeStaging(async (agent,part) => {
    const subject = ownership.owner('session',agent.id)
    if (subject) await ownership.bindUpload(subject,part.type,part.attachment)
  }), 'shared chat: register employee uploads')
  ctx.effect(() => ctx.sessionController.registerModelCatalogPolicy(principal => localSelection(ctx,principal.subject)),
    'shared chat: private model settings')
  const portfolio = createPortfolioStore(ctx.claimsDatabase)
  const pending = new Map()
  async function workspace(principal) {
    const subject = principal.subject
    const key = subject + '/' + (principal.department || 'claims')
    if (principal.kind !== 'claims-user' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(subject))
      throw Error('Unknown Chat employee')
    if (pending.has(key)) return pending.get(key)
    const work = (async () => {
      // This empty native registry directory is metadata. Employee files live on the engine volume.
      const path = join(process.env.DSH_HOME, 'native-chat', deployment, subject, ...(principal.department ? [principal.department] : []), 'Documents')
      await mkdir(path, { recursive: true, mode: 0o700 })
      const item = await ctx.workspaceRegistry.resolveByPath(path) ?? await ctx.workspaceRegistry.create(path)
      await ownership.bind(subject, 'workspace', item.id, principal.department)
      ctx.remoteAccess.invalidate(principal)
      return item
    })()
    pending.set(key, work)
    try { return await work } finally { pending.delete(key) }
  }
  ctx.effect(() => ctx.sessionController.registerCreationPolicy(async (principal, request, create) => {
    const deny = () => { throw new RemoteError('remote-access/denied', 'Session creation denied', { action: 'session/create', reason: 'employee-workspace' }) }
    if (principal.kind !== 'claims-user' || request.cwd !== undefined || request.agentPreset !== undefined) deny()
    const id = request.workspaceId ?? (await workspace(principal)).id
    if (!ownership.belongs(principal, 'workspace', id) ||
        (request.sessionId && !ownership.belongs(principal, 'session', request.sessionId))) deny()
    // The caller may suggest its own session, but a shared allocation always reserves a fresh ID.
    // Native blank-session reuse can mint a replacement after publication.
    const sessionId = 'session-' + randomUUID()
    // Reserve before publication so an observer can authorize the very first native event.
    await ownership.bind(principal.subject, 'session', sessionId, principal.department)
    ctx.remoteAccess.invalidate(principal)
    const result = await create({ workspaceId: id, agentPreset: 'employee-chat', sessionId })
    if (result.sessionId !== sessionId) throw Error('Unexpected native session allocation')
    return result
  }, id => ownership.owner('session', id) ? 'employee-chat' : undefined), 'shared chat: native session allocation')
  ctx.effect(() => ctx.typertGateway.registerInteractionPolicy((principal, event, id) =>
    principal.kind === 'claims-user' && event === 'approval/request' && ownership.belongs(principal, 'session', id)),
    'shared chat: private approvals')
  ctx.effect(() => ctx.terminalController.registerUserBackend(agent => {
    const subject = ownership.owner('session',agent.id)
    if (!subject || ownership.profile('session',agent.id) !== 'claims') return
    return { cwd:'/workspace',shell:{name:'sh',path:'/bin/sh',args:['-i']},async open(cols,rows,signal) {
      signal.throwIfAborted()
      const handle=await openProcess({subject,kind:'terminal',argv:['/bin/sh','-i'],cols,rows})
      if (signal.aborted) { await handle.terminate(); signal.throwIfAborted() }
      return handle
    } }
  }), 'shared chat: employee terminals')
  ctx.remoteAccess.registerPolicy('claims-user', { bindings: ownership.bindings })
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/chat', async handler(req, res) {
    res.setHeader('cache-control', 'no-store')
    const url = new URL(req.url, origin)
    if (req.method !== 'GET') { res.writeHead(405).end(); return }
    const sessionId=standardChatId(url.searchParams)
    if (!sessionId && !chatTarget(url.searchParams)) { res.writeHead(400).end(); return }
    const admission = ctx.claimsAuth.admit(req)
    if ('rejection' in admission) {
      if (admission.rejection === 401) res.writeHead(303, { location: loginHref('/chat' + url.search) }).end()
      else res.writeHead(403).end()
      return
    }
    if (sessionId && !ownership.belongs(admission.peer.principal,'session',sessionId)) {res.writeHead(404).end();return}
    const record = url.searchParams.get('record')
    if (record) {
      const user = admission.peer.principal
      if (!user.department) { res.writeHead(404).end(); return }
      try { await portfolio.detail(user, record) }
      catch (error) { if (![403, 404].includes(error.status)) throw error; res.writeHead(404).end(); return }
    }
    await workspace(admission.peer.principal)
    const page = await ctx.webServer.readResource(new Request(new URL('/', origin)), admission.peer)
    if (admission.peer.signal.aborted) { res.writeHead(401).end(); return }
    res.writeHead(page.status, { 'content-type': page.headers.get('content-type') || 'text/html' })
    const html = await page.text()
    const department = admission.peer.principal.department
    const content = department === 'finance' || department === 'legal'
      ? html.replace('<head>', '<head><meta name="employee-chat-department" content="' + department + '">') : html
    res.end(sessionId ? content.replace('<head>', '<head><meta name="dsh-initial-session" content="'+sessionId+'">') : content)
  } }), 'shared chat: authenticated page')
  ctx.effect(() => ctx.webServer.register({kind:'exact',path:'/chat/uploads',async handler(req,res) {
    res.setHeader('cache-control','no-store');res.setHeader('x-content-type-options','nosniff')
    const admission=ctx.claimsAuth.admit(req)
    if ('rejection' in admission) {res.writeHead(admission.rejection).end();return}
    if (req.method!=='GET') {res.writeHead(405).end();return}
    if (admission.peer.principal.department) {res.writeHead(403).end();return}
    const {principal,signal}=admission.peer,id=new URL(req.url,origin).searchParams.get('id')
    if (!id) {
      const rows=await ownership.uploads(principal.subject)
      if(signal.aborted){res.writeHead(401).end();return}
      res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(rows));return
    }
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)) {res.writeHead(404).end();return}
    const row=await ownership.upload(principal.subject,id)
    if(!row || signal.aborted) {res.writeHead(404).end();return}
    res.setHeader('content-type','application/octet-stream')
    res.setHeader('content-disposition',"attachment; filename*=UTF-8''"+encodeURIComponent(row.reference.name || 'image'))
    if(row.kind==='image') {const image=await ctx.attachments.readImage(row.reference,signal);res.end(Buffer.from(image.data))}
    else {
      const stream=Readable.from(ctx.attachments.readFileStream(row.reference,signal))
      stream.once('error',()=>res.destroy());res.once('close',()=>stream.destroy());stream.pipe(res)
    }
  }}),'shared chat: private upload downloads')
  ctx.effect(() => ctx.webServer.register({kind:'exact',path:'/chat/files',async handler(req,res) {
    res.setHeader('cache-control','no-store')
    try {
      if (!['POST','GET'].includes(req.method)) {res.writeHead(405).end();return}
      const principal=ctx.claimsAuth.require(req,{write:req.method==='POST'})
      if (principal.department) {res.writeHead(403).end();return}
      const url=new URL(req.url,origin), action=req.method==='POST' ? 'write' : url.searchParams.has('read') ? 'read' : 'list'
      const file={action,path:url.searchParams.get('path') || ''}
      if (action==='write') {
        const chunks=[];let size=0
        for await(const chunk of req) { size+=chunk.length;if(size>200000){res.writeHead(413).end();return}chunks.push(chunk) }
        file.text=Buffer.concat(chunks).toString('utf8')
      }
      const peer=ctx.claimsAuth.admit(req).peer
      if (!peer) {res.writeHead(401).end();return}
      const body=Buffer.from(JSON.stringify({subject:principal.subject,file}))
      const upstream=request({socketPath:process.env.CLAIMS_WORKSPACE_MANAGER_SOCKET || '/run/chat-manager/workspace.sock',
        path:'/files',method:'POST',signal:peer.signal,headers:{'content-type':'application/json','content-length':body.length}}, reply=>{
          res.writeHead(reply.statusCode,{'content-type':'application/json'});reply.pipe(res)
        })
      upstream.on('error',()=>{if(!res.headersSent)res.writeHead(503);res.end()})
      upstream.end(body)
    } catch(error) {res.writeHead(error.status || 503).end()}
  }}),'shared chat: employee files')
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/api/session/uploadFileBinary', async handler(req, res) {
    const admission = ctx.claimsAuth.admit(req)
    if ('rejection' in admission) { res.writeHead(admission.rejection).end(); return }
    const url = new URL(req.url, origin)
    if (req.method !== 'POST' || req.headers.origin !== origin || url.searchParams.getAll('sessionId').length !== 1 ||
        admission.peer.principal.department || !ownership.belongs(admission.peer.principal,'session',url.searchParams.get('sessionId'))) {
      res.writeHead(403).end(); return
    }
    const request = new Request(url, { method: 'POST', headers: req.headers, body: Readable.toWeb(req),
      duplex: 'half', signal: admission.peer.signal })
    const response = await handleFileUploadHttp(ctx.fileUploads, request)
    const body=await response.text()
    if (admission.peer.signal.aborted) {res.writeHead(401).end();return}
    res.writeHead(response.status, { 'cache-control': 'no-store', 'content-type': 'application/json' }).end(body)
  } }), 'shared chat: private uploads')
}
