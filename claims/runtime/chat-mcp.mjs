import { readWageReview } from './wage-review.mjs'
import { widgetResources } from './widget-resources.mjs'
import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { once } from 'node:events'
import { claimLines, claimSourceStatuses } from '../domain/claim-access.mjs'
import { DomainError } from '../domain/index.mjs'
import { selectedDocumentIds } from '../domain/chat.mjs'
import { timelineRpc, timelineSources } from '../showcase/timeline.mjs'

const caseResource = {
  uri: 'ui://enterprise-agent/open-cases.html', name: 'Case list', mimeType: 'text/html;profile=mcp-app',
}
const summaryResource = {
  uri: 'ui://enterprise-agent/portfolio-summary.html', name: 'Portfolio summary', mimeType: caseResource.mimeType,
}
const string = { type: 'string' }
const claim = {
  claimId: { type: 'string', description: 'A selected claim ID. Optional when only one is selected.' },
}
const portfolioFilters = {
  status: { type: 'string', enum: ['open','closed','all'] },
  lob: { type: 'string', enum: claimLines, description: 'One exact business line. Use lobs for multiple lines.' },
  lobs: { type: 'array', items: { type: 'string', enum: claimLines }, minItems: 1, maxItems: claimLines.length,
    uniqueItems: true, description: 'Any of the specified lines. Unqualified auto includes AUTO and COMM_AUTO. Omit lob when supplying lobs.' },
  sourceStatus: { type: 'string', enum: claimSourceStatuses, description: 'Exact source status such as Paid, independently of the open or closed Workbench lifecycle.' },
  ownerId: { type: 'string', description: 'Optional assignee filter for the claims administrator.' },
}
const actionTools = ['list_claim_actions','check_action_status','read_juris_record','prepare_claim_action']
const definitions = {
  list_claim_actions:['List this employee’s available actions on the selected claim.',{}],
  read_juris_record:['Read confirmed handling fields, notes and diaries from mock Juris.',{}],
  check_action_status:['Read pending reviews, partner task status and destination receipts.',{}],
  prepare_claim_action:['Prepare the requested change for human review. Supply only fields for this action. Diary dueAt must be an ISO UTC instant. Notes use General, Contact or Supplemental.',{
    action:string,category:string,text:string,field:string,value:string,reason:string,purpose:string,dueAt:string,diaryId:string,completion:string,
    documentId:string,anchorId:string},['action']],
  portfolio_summary: ['Group the authorized CMS-MCP portfolio with exact counts, billings and litigated counts. Defaults to all lifecycles.', {
    ...portfolioFilters, groupBy: { type: 'string', enum: ['lob','status','adjuster'] }, assignedOnly: { type: 'boolean' },
  }],
  search_claims: [
    'Search authorized claim summaries. Set waitingOnly for the Workbench waiting queue, dueToday for deadlines later today and assignedOnly when the user asks for their own claims. Omit query for a whole-portfolio listing. Query terms must all match one claim; search explicitly named IDs individually. For comparison discovery, omit query to review the summaries.',
    {
      ...portfolioFilters, query: string,
      assignedOnly: { type: 'boolean' },
      dueToday: { type: 'boolean' },
      waitingOnly: { type: 'boolean' },
      offset: { type: 'integer', minimum: 0 },
    },
  ],
  review_wage_evidence: ['Review documented payroll coverage, gaps and conflicting wage sources for one fully selected claim. Return an order array of the supplied fact IDs in the final response.', {}],
  get_claim_brief: ['Read the selected claim status, recorded reason, owner and next action.', claim],
  list_evidence: [
    'List document IDs and their passage IDs and labels. Use this before reading source documents.',
    claim,
  ],
  read_evidence: [
    'Read one exact document passage. Use documentId and anchorId from list_evidence. For a comparison read each relevant document.',
    { ...claim, documentId: string, anchorId: string },
    ['documentId', 'anchorId'],
  ],
  claim_timeline: [
    'Display the recorded events and dates of the selected claim as an interactive timeline.',
    claim,
  ],
}
const labels = {
  read_juris_record:'Reading the current Juris record',list_claim_actions:'Checking available actions',check_action_status:'Checking action receipts',prepare_claim_action:'Preparing a review',
  portfolio_summary: 'Summarizing CMS-MCP claims',
  search_claims: 'Searching claim summaries',
  review_wage_evidence: 'Checking wage evidence',
  get_claim_brief: 'Reading claim summary',
  list_evidence: 'Finding documents',
  read_evidence: 'Reading a source passage',
  claim_timeline: 'Reading the claim timeline',
}

/** Keep the MCP result projection and the answer verifier on the same authorized reads. */
export function createClaimReads({
  domain,
  principal,
  scope,
  allowed,
  reauthorize,
  requestedAction,
  wagePilot = process.env.CLAIMS_WAGE_REVIEW === '1',
  onActivity,
  signal,
  trace,
}) {
  const portfolio = scope.kind === 'portfolio'
  const names = allowed.filter(
    (name) =>
      scope.kind !== 'workspace' &&
      Object.hasOwn(definitions, name) &&
      (!actionTools.includes(name) || domain.availableActions && /^(CLM-\d{6}|WC-102)$/.test(scope.claimIds?.[0]) && scope.kind==='claim' && scope.claimIds?.length===1 &&
        !selectedDocumentIds(scope,scope.claimIds[0]) && (name!=='prepare_claim_action' || requestedAction && !['list','status','record'].includes(requestedAction))) &&
      (name !== 'review_wage_evidence' || wagePilot && scope.kind === 'claim' && scope.claimIds.length === 1 && !selectedDocumentIds(scope, scope.claimIds[0])) &&
      (name !== 'portfolio_summary' || typeof domain.portfolioSummary === 'function') &&
      (name !== 'get_claim_brief' || scope.claimIds?.some(id => !selectedDocumentIds(scope, id))) &&
      (portfolio === ['search_claims','portfolio_summary'].includes(name)) &&
      (scope.kind !== 'document' || ['list_evidence', 'read_evidence'].includes(name)),
  )
  const tools = names.map((name) => {
    const [description, properties, fields = []] = definitions[name]
    const required = scope.kind === 'multi' && name !== 'read_evidence' ? ['claimId', ...fields] : fields
    return {
      name,
      description,
      inputSchema: { type: 'object', properties, required, additionalProperties: false },
      annotations: { readOnlyHint: name !== 'prepare_claim_action' },
      ...(name === 'portfolio_summary' && { _meta: { ui: { resourceUri: summaryResource.uri } } }),
      ...(name === 'search_claims' && { _meta: { ui: { resourceUri: caseResource.uri } } }),
    }
  })
  const dependencies = new Map(),
    activity = new Map(),
    reads = [],
    inventory = new Map(),
    summaries = new Map()
  const timelines = new Map(),
    searches = []
  const attachments = new Map(), attachedBriefs = new Map()
  let actionResult, prepared
  let wageReview, portfolioSummary,
    summaryFilters,
    search,
    failed,
    calls = 0,
    verifierActive = false,
    publish = Promise.resolve()
  const dependenciesOfTurn = () => [...dependencies.values()]
  const check = async () => {
    signal.throwIfAborted()
    if (failed) throw failed
    await reauthorize(dependenciesOfTurn())
    signal.throwIfAborted()
  }
  function remember(dep) {
    const key = JSON.stringify([dep.claimId, dep.documentId ?? null])
    const prior = dependencies.get(key)
    if (prior && (prior.claimVersion !== dep.claimVersion || prior.documentVersion !== dep.documentVersion))
      throw new DomainError(409, 'stale_version')
    dependencies.set(key, dep)
  }
  async function emit(entry) {
    activity.set(entry.id, entry)
    // Native models can request several tools in one step. Serialize durable activity
    // updates so a slow earlier write cannot overwrite a later tool completion.
    publish = publish.then(() => onActivity?.(entry, dependenciesOfTurn()))
    await publish
  }
  async function read(name, args) {
    if (name === 'portfolio_summary') {
      portfolioSummary = await domain.portfolioSummary(principal, args)
      summaryFilters = args
      for (const group of portfolioSummary.groups) {
        for (const item of group.items) remember({ claimId: item.id, claimVersion: item.version })
      }
      return portfolioSummary
    }
    if (name === 'search_claims') {
      const {
        items,
        total,
        asOf,
        dependencies: deps,
      } = await domain.chatSearch(principal, { ...args, limit: 12 })
      deps.forEach(remember)
      search = {
        filters: { ...args },
        items: items.map(({ id, title, reason, nextAction, dueAt, section, lob, sourceStatus, ownerId }) => ({
          ...(lob && { lob, sourceStatus, ownerId }),
          id,
          title,
          reason,
          nextAction,
          dueAt,
          section,
        })),
        total,
        asOf,
      }
      searches.push(search)
      return search
    }
    let id = args.claimId ?? (scope.claimIds?.length === 1 ? scope.claimIds[0] : undefined)
    // An omitted claimId may resolve only through this turn's authorized inventory.
    // Never guess the owner by parsing a document ID or searching the global store.
    if (id === undefined && name === 'read_evidence') {
      const owners = [...inventory].filter(([, docs]) => docs.some((d) => d.documentId === args.documentId))
      if (owners.length === 1) id = owners[0][0]
    }
    if (actionTools.includes(name)) {
      const view=await domain.availableActions(principal,id)
      remember({claimId:id,claimVersion:view.version})
      if(name==='read_juris_record') {
        const r=view.record
        const lines=['Handling priority · '+r.handlingPriority,'Next handling instruction · '+(r.nextHandlingInstruction || 'None recorded'),
          ...r.notes.map(n=>n.category+' note · '+n.text+' ('+n.source+')'),
          ...r.diaries.map(d=>d.status+' diary · '+d.dueAt+' · '+d.purpose+(d.completion?' · '+d.completion:''))]
        actionResult={claimId:id,revision:r.revision,text:lines.join('\n')}
      } else if (name==='prepare_claim_action') {
        const {action,documentId,anchorId,...values}=args
        if (action!==requestedAction || !view.actions.includes(action)) throw new DomainError(400,'action_unavailable')
        prepared ??= await domain.prepare(principal,id,{action,values,documentId,anchorId,expectedVersion:view.version})
        actionResult={claimId:id,proposalId:prepared.id,text:'Draft prepared. Review the exact change below.'}
      } else {
        const reviews=view.reviews.map(p=>({action:p.action,status:p.operationState || p.status,receiptId:p.receiptId}))
        actionResult={claimId:id,actions:view.actions,reviews,wages:view.wages.map(w=>({state:w.state,taskId:w.taskId})),
          text:name==='list_claim_actions'?'Available actions for '+id+': '+view.actions.map(a=>a.replaceAll('_',' ')).join(', '):
            [...reviews.map(r=>r.action.replaceAll('_',' ')+' · '+r.status+(r.receiptId?' · '+r.receiptId:'')),
              ...view.wages.map(w=>'Wage request · '+w.state+(w.taskId?' · '+w.taskId:''))].join('\n') || 'No actions recorded for '+id}
      }
      return actionResult
    }
    const selected = selectedDocumentIds(scope, id)
    if (
      !id || !scope.claimIds?.includes(id) ||
      (selected && ((args.documentId && !selected.includes(args.documentId)) || name === 'get_claim_brief'))
    )
      throw new DomainError(400, 'use_selected_claim_or_document')
    const detail = name === 'get_claim_brief'
      ? await (domain.chatBrief ? domain.chatBrief(principal, id) : domain.detail(principal, id))
      : await domain.chatEvidenceIndex(principal, scope, id)
    const { item } = detail
    const base = { claimId: id, claimVersion: item.version }
    remember(base)
    if (name === 'get_claim_brief') {
      const { title, ownerId, reason, nextAction, dueAt, state, source } = item
      const brief = { ...base, title, ownerId, reason, nextAction, dueAt, state, source,
        ...(item.claimNumber && { claimNumber: item.claimNumber, sourceStatus: item.sourceStatus,
          lifecycle: item.lifecycle, lob: item.lob, policyNumber: item.policyNumber }) }
      summaries.set(id, brief)
      return brief
    }
    const docs = detail.documents
    const sourceRef = (doc, anchorId) => ({
      ...base,
      documentId: doc.id,
      documentVersion: doc.version,
      anchorId,
      title: doc.title,
    })
    if (name === 'review_wage_evidence') {
      for (const doc of docs) remember({ ...base, documentId: doc.id, documentVersion: doc.version })
      wageReview = await readWageReview(docs, async (doc, anchorId) => {
        const ref = sourceRef(doc, anchorId)
        const current = await domain.chatSource(principal, ref)
        return { ref, text: current.anchors.find(a => a.id === anchorId)?.text }
      })
      return { facts: wageReview.facts.map(({ id, component }) => ({ id, component })) }
    }
    if (name === 'list_evidence') {
      const documents = docs.map(({ id, version, title, kind, source, asOf, anchors }) => ({
        documentId: id,
        documentVersion: version,
        title,
        kind,
        source,
        asOf,
        passages: anchors.map(({ id, label }) => ({ anchorId: id, label })),
      }))
      for (const doc of docs) remember({ ...base, documentId: doc.id, documentVersion: doc.version })
      inventory.set(id, documents)
      return { ...base, documents }
    }
    if (name === 'read_evidence') {
      const doc = docs.find((d) => d.id === args.documentId)
      if (!doc?.anchors.some((a) => a.id === args.anchorId)) {
        const error = new DomainError(400, 'select_listed_document_and_anchor')
        const listed = inventory.get(id)?.find((d) => d.documentId === args.documentId)
        if (listed) {
          await check()
          error.repair = `For ${listed.documentId}, choose one of these exact anchor IDs: ${listed.passages.map((p) => `${p.anchorId} (${p.label})`).join(', ')}.`
        }
        throw error
      }
      const ref = sourceRef(doc, args.anchorId)
      const verified = await domain.chatSource(principal, ref)
      const anchor = verified.anchors.find((a) => a.id === ref.anchorId)
      if (!anchor?.text) throw new DomainError(409, 'stale_version')
      remember({ ...base, documentId: ref.documentId, documentVersion: ref.documentVersion })
      const excerpt = { ...ref, quote: anchor.text.slice(0, 900) }
      if (
        !reads.some(
          (old) => old.claimId === id && old.documentId === ref.documentId && old.anchorId === ref.anchorId,
        )
      )
        reads.push(excerpt)
      return excerpt
    }
    let data
    if (selected) {
      // Claim-wide event prose can combine multiple documents. In a subset show the
      // recorded receipt of each selected source without loading the whole claim timeline.
      data = { itemId: id, events: [], sources: timelineSources(docs) }
    } else {
      const result = await timelineRpc(domain, principal, id, {
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name, arguments: { expectedVersion: item.version } },
      }, docs)
      data = result.result.structuredContent
    }
    const refs = new Map()
    function verifyLink(docId, anchorId) {
      const doc = docs.find((d) => d.id === docId)
      if (!doc?.anchors.some((a) => a.id === anchorId)) throw new DomainError(409, 'stale_version')
      remember({ ...base, documentId: doc.id, documentVersion: doc.version })
      refs.set(JSON.stringify([docId, anchorId]), sourceRef(doc, anchorId))
    }
    for (const row of data.sources) verifyLink(row.id, row.anchorId)
    for (const row of data.events) if (row.document) verifyLink(row.document, row.anchorId)
    timelines.set(id, { data: { ...data, version: item.version }, refs: [...refs.values()] })
    return {
      ...base,
      recordedEvents: [...data.events, ...data.sources].map(({ at, title }) => ({ recordedAt: at, title })),
    }
  }
  async function call(name, args) {
    const def = tools.find((t) => t.name === name)
    if (
      !def ||
      !args ||
      typeof args !== 'object' ||
      Array.isArray(args) ||
      Object.keys(args).some((k) => !Object.hasOwn(def.inputSchema.properties, k)) ||
      def.inputSchema.required.some((k) => typeof args[k] !== 'string' || !args[k])
    )
      throw new DomainError(400, 'invalid_claim_tool_arguments')
    for (const [key, value] of Object.entries(args)) {
      const type = def.inputSchema.properties[key].type
      if (key === 'lobs') {
        if (Object.hasOwn(args, 'lob') || !Array.isArray(value) || !value.length || value.length > claimLines.length ||
            new Set(value).size !== value.length || !value.every(line => claimLines.includes(line)))
          throw new DomainError(400, 'invalid_claim_tool_arguments')
        continue
      }
      if (
        type === 'integer'
          ? !Number.isSafeInteger(value) || value < 0
          : typeof value !== type || (type === 'string' && value.length > (name==='prepare_claim_action'?2000:256))
      )
        throw new DomainError(400, 'invalid_claim_tool_arguments')
    }
    await check()
    if (++calls > Math.max(20, (scope.claimIds?.length || 1) * 4))
      throw new DomainError(422, 'chat_read_limit')
    const prefix = verifierActive ? 'Verifier · ' : ''
    const step = {
      id: String(calls),
      tool: name,
      origin: verifierActive ? 'verifier' : 'model',
      label: prefix + labels[name],
      state: 'running',
    }
    await emit(step)
    try {
      const data = trace ? await trace.run('chat.' + name, () => read(name, args)) : await read(name, args)
      await check()
      const label =
        name === 'read_evidence' ? prefix + 'Read ' + data.claimId + ' · ' + data.title : step.label
      await emit({ ...step, label, state: 'completed' })
      const modelData = name === 'portfolio_summary'
        ? { ...data, groups: data.groups.map(({ items, ...metrics }) => metrics) } : data
      return { content: [{ type: 'text', text: JSON.stringify(modelData) }], structuredContent: data }
    } catch (error) {
      if (error.status !== 400) failed = error
      await emit({ ...step, state: 'failed' })
      throw error
    }
  }
  return {
    tools,
    call,
    check,
    emit,
    // Hydration uses the protected readers directly and never counts as a model tool call.
    // Keep available passages separate from those the model/verifier used for its answer.
    async hydrate(byteBudget) {
      const payload = { briefs: [], documents: [], excerpts: [], truncated: false }
      let remaining = byteBudget - Buffer.byteLength(JSON.stringify(payload))
      function add(list, object) {
        const size = Buffer.byteLength(JSON.stringify(object)) + 1
        if (size > remaining) { payload.truncated = true; return false }
        remaining -= size
        list.push(object)
        return true
      }
      for (const claimId of scope.claimIds || []) {
        if (remaining < 160) { payload.truncated = true; break }
        await check()
        const subset = selectedDocumentIds(scope, claimId)
        if (!subset && names.includes('get_claim_brief')) {
          const brief = await read('get_claim_brief', {claimId})
          summaries.delete(claimId)
          if (add(payload.briefs, brief)) attachedBriefs.set(claimId, brief)
        }
        if (!names.includes('list_evidence')) continue
        const index = await read('list_evidence', {claimId})
        for (const doc of index.documents) {
          if (!add(payload.documents, {claimId,documentId:doc.documentId,version:doc.documentVersion,title:doc.title})) break
          if (!subset || !names.includes('read_evidence') || !doc.passages.length) continue
          const base = {claimId,claimVersion:index.claimVersion,documentId:doc.documentId,documentVersion:doc.documentVersion,title:doc.title}
          const current = await domain.chatSource(principal, {...base,anchorId:doc.passages[0].anchorId})
          for (const {id:anchorId,text} of current.anchors) {
            if (!text || !doc.passages.some(p => p.anchorId === anchorId)) continue
            const sourceId = 's' + (attachments.size + 1)
            const excerpt = {...base,anchorId,quote:text.slice(0,900)}
            if (excerpt.quote.length < text.length) payload.truncated = true
            if (!add(payload.excerpts,{sourceId,documentId:doc.documentId,anchorId,quote:excerpt.quote})) break
            attachments.set(sourceId, excerpt)
          }
        }
      }
      await check()
      return payload
    },
    selectAttached(ids) {
      if (!Array.isArray(ids) || ids.length > attachments.size || ids.some(id => !attachments.has(id))) return false
      for (const id of ids) {
        const ref = attachments.get(id)
        if (!reads.some(old => old.documentId === ref.documentId && old.anchorId === ref.anchorId)) reads.push(ref)
      }
      return true
    },
    useAttached(name,args) {
      if (name !== 'read_evidence') return false
      for (const ref of attachments.values()) {
        if (ref.claimId === args.claimId && ref.documentId === args.documentId && ref.anchorId === args.anchorId) {
          if (!reads.some(old => old.documentId === ref.documentId && old.anchorId === ref.anchorId)) reads.push(ref)
          return true
        }
      }
      return false
    },
    // Invoked only after the turn's native model has gone idle. Each endpoint and flag belong to one turn.
    async verifyWith(dispatch) {
      verifierActive = true
      try {
        return await dispatch()
      } finally {
        verifierActive = false
      }
    },
    state: () => ({
      activity: [...activity.values()],
      dependencies: dependenciesOfTurn(),
      reads,
      inventory,
      summaries, attachedBriefs, portfolioSummary, summaryFilters, cmsSummaryEnabled: names.includes('portfolio_summary'),
      timelines,
      wageReview, wagePilot, actionResult,
      search,
      searches,
    }),
  }
}

/** A turn-scoped 2025-11-25 Streamable HTTP endpoint accessible only on server loopback. */
export async function startClaimMcp(reads, signal, serverName = 'enterprise-claims') {
  const resources = [caseResource, summaryResource].filter(resource =>
    reads.tools.some(tool => tool._meta?.ui?.resourceUri === resource.uri))
  const hasCases = resources.length > 0
  const bearer = Buffer.from('Bearer ' + randomBytes(32).toString('base64url'))
  const server = createServer(async (req, res) => {
    const credential = Buffer.from(req.headers.authorization || '')
    if (
      req.url !== '/mcp' ||
      req.headers.origin ||
      signal.aborted ||
      credential.length !== bearer.length ||
      !timingSafeEqual(credential, bearer)
    )
      return res.writeHead(403).end()
    if (req.method !== 'POST') return res.writeHead(405, { allow: 'POST' }).end()
    let id = null
    function reply(payload) {
      res
        .writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        .end(JSON.stringify({ jsonrpc: '2.0', id, ...payload }))
    }
    try {
      let size = 0
      const parts = []
      for await (const part of req) {
        if ((size += part.length) > 16384) return res.writeHead(413).end()
        parts.push(part)
      }
      const rpc = JSON.parse(Buffer.concat(parts).toString())
      if (rpc.jsonrpc !== '2.0') return reply({ error: { code: -32600, message: 'Invalid request' } })
      if (rpc.id === undefined && rpc.method.startsWith('notifications/')) return res.writeHead(202).end()
      id = rpc.id
      if (rpc.method === 'initialize')
        return reply({
          result: {
            protocolVersion: '2025-11-25',
            capabilities: { tools: {}, ...(hasCases && { resources: {} }) },
            serverInfo: { name: serverName, version: '1.0' },
          },
        })
      if (hasCases && rpc.method === 'resources/list') return reply({ result: { resources } })
      if (hasCases && rpc.method === 'resources/read') {
        const resource = resources.find(r => r.uri === rpc.params?.uri)
        if (!resource) return reply({ error: { code: -32602, message: 'Unknown resource' } })
        const widget = widgetResources.get(resource === caseResource ? 'open-cases' : 'portfolio-summary')
        return reply({ result: { contents: [widget] } })
      }
      if (rpc.method === 'tools/list') return reply({ result: { tools: reads.tools } })
      if (rpc.method === 'tools/call')
        return reply({ result: await reads.call(rpc.params?.name, rpc.params?.arguments || {}) })
      if (rpc.method === 'ping') return reply({ result: {} })
      reply({ error: { code: -32601, message: 'Method unavailable' } })
    } catch (error) {
      reply({
        result: {
          isError: true,
          content: [
            {
              type: 'text',
              text: error instanceof DomainError ? error.repair || error.code : 'claim_read_unavailable',
            },
          ],
        },
      })
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  let closing
  function close() {
    signal.removeEventListener('abort', close)
    if (!closing) {
      closing = new Promise((resolve) => server.close(resolve))
      server.closeAllConnections()
    }
    return closing
  }
  signal.addEventListener('abort', close, { once: true })
  if (signal.aborted) {
    await close()
    signal.throwIfAborted()
  }
  return { url: `http://127.0.0.1:${port}/mcp`, authorization: bearer.toString(), close }
}
