import { pdfViewerHref } from './pdf-link.mjs'
const labels = {add_note:'Draft claim note',update_field:'Update handling field',create_diary:'Schedule callback or diary',
  reschedule_diary:'Reschedule diary',complete_diary:'Complete diary',request_wages:'Prepare wage request',
  record_wage_evidence:'File wage evidence',review_wages:'Review returned wage periods',status:'Check action status'}
const approvals = {add_note:'Approve and add note',update_field:'Approve field update',create_diary:'Approve and create diary',
  reschedule_diary:'Approve and reschedule diary',complete_diary:'Approve diary completion',request_wages:'Approve and send wage request',
  record_wage_evidence:'Approve and file wage evidence'}
const captions = {handlingPriority:'Handling priority',nextHandlingInstruction:'Next handling instruction',dueAt:'Due date',
  diaryId:'Diary entry',dateRangeStart:'Period start',dateRangeEnd:'Period end',associateName:'Associate',adjusterEmail:'Adjuster email'}
const caption = key => captions[key] || (key[0].toUpperCase()+key.slice(1)).replace(/([a-z])([A-Z])/g,'$1 $2')
const element = (tag,text,cls) => {
  const e=document.createElement(tag)
  if (text!==undefined) e.textContent=text
  if (cls) e.className=cls
  return e
}
const formatted = value => typeof value === 'object' && value !== null
  ? Object.entries(value).map(([k,v])=>caption(k)+' · '+v).join('\n') : String(value ?? 'Empty')
export async function actionRequest(path,body,csrf,signal) {
  const res = await fetch('/claims/api/'+path,{credentials:'same-origin',cache:'no-store',signal,
    ...(body && {method:'POST',headers:{'content-type':'application/json','x-csrf-token':csrf},body:JSON.stringify(body)})})
  const data = await res.json()
  if (!res.ok) throw Error(res.status===409 ? 'The record or review changed. Refresh and review the current values.' :
    res.status===403 || res.status===404 ? 'This action is unavailable for your current assignment.' : data.code || 'The claims service is unavailable.')
  return data
}

/** Both Chat and Workbench mount this employee-owned editor and review control. */
export function mountActionReview(root,{claimId,csrf,request= (p,b)=>actionRequest(p,b,csrf),context={},workbench=false,onChange}) {
  let live=true, state, busy=false, current=context.proposalId, editing, error='', form, statusOnly=context.showStatus===true
  root.classList.add('claim-action-review')
  const controls=element('div',undefined,'cw-actions')
  const message=element('p',undefined,'cw-meta')
  message.setAttribute('role','status')
  async function refresh() {
    const next=await request('items/'+encodeURIComponent(claimId)+'/actions')
    if (live) {state=next;render()}
  }
  const button=(container,label,fn)=>{
    const b=element('button',label,'cw-btn'); b.type='button'
    b.onclick=async()=>{
      if (busy) return
      busy=true; error=''; controls.inert=true; message.textContent='Working…'
      try {await fn()} catch(e){error=e.message}
      finally {busy=false;controls.inert=false;if(live) message.textContent=error}
    }
    container.append(b)
    return b
  }
  function field(parent,name,title,value,options,type='text') {
    const wrapper=element('label',title,'cw-action-field')
    const input=element(options?'select':type==='textarea'?'textarea':'input')
    if (input.tagName==='INPUT') input.type=type
    if (options) for (const entry of options) {
      const [v,label]=Array.isArray(entry)?entry:[entry,entry]
      const option=element('option',label); option.value=v; input.append(option)
    }
    input.name=name;input.required=true
    if(value!==undefined && value!==null)input.value=value
    wrapper.append(input);parent.append(wrapper);return input
  }
  function editor(action,p) {
    editing=action
    form=element('form'); form.onsubmit=e=>e.preventDefault()
    const v=p?.payload.values || context.values || {}
    form.append(element('h4',labels[action]+' · '+claimId))
    if(action==='add_note') {
      field(form,'category','Note category',v.category || (state.finalized?'Supplemental':context.mailSummary?'Contact':'General'),
        state.finalized?['Supplemental']:['General','Contact'])
      field(form,'text','Note text',v.text ?? context.note ?? '',null,'textarea')
      form.append(element('p','The approved text and source label will be visible to employees with claim access.','cw-meta'))
      if(context.mailSummary || p?.payload.source==='Outlook email summary') {
        const share=element('label','Share this summary with authorized reviewers before filing ')
        const box=element('input');box.type='checkbox';box.name='shareSummary';share.append(box);form.append(share)
      }
    } else if(action==='update_field') {
      const kind=field(form,'field','Field',v.field || 'handlingPriority',[['handlingPriority','Handling priority'],['nextHandlingInstruction','Next handling instruction']])
      const slot=element('div');form.append(slot)
      function valueField(){slot.replaceChildren(element('p','Current value · '+formatted(state.record[kind.value])))
        field(slot,'value','Proposed value',kind.value===v.field?v.value:state.record[kind.value],
          kind.value==='handlingPriority'?['Routine','High','Urgent']:null)}
      kind.onchange=valueField;valueField()
      field(form,'reason','Reason',v.reason)
    } else if(action.includes('diary')) {
      if(action!=='create_diary')field(form,'diaryId','Open diary',v.diaryId,state.record.diaries.filter(d=>d.status==='Open').map(d=>[d.id,d.purpose+' · '+d.dueAt]))
      else field(form,'purpose','Purpose',v.purpose)
      if(action==='complete_diary')field(form,'completion','What satisfied the obligation?',v.completion)
      else {
        const due=v.dueAt && new Date(v.dueAt)
        field(form,'dueAt','Due date and time (local)',due && new Date(due-due.getTimezoneOffset()*60000).toISOString().slice(0,16),null,'datetime-local')
      }
      form.append(element('small','Responsible adjuster · '+(p?.payload.previousValue?.owner || state.owner)))
    }
    button(form,'Prepare for review',async()=>{
      if(!form.reportValidity())return
      const values=Object.fromEntries(new FormData(form))
      const shareSummary=values.shareSummary==='on';delete values.shareSummary
      if(values.dueAt)values.dueAt=new Date(values.dueAt).toISOString()
      const source=p?.payload.documentId?p.payload:context.source
      const draft=await request('items/'+claimId+'/prepare',{action,expectedVersion:state.version,values,
        ...(p && {replaces:p.id}),...(source && {documentId:source.documentId,anchorId:source.anchorId,sourceVersion:source.documentVersion,sourceClaimVersion:source.claimVersion}),
        ...((context.mailSummary || p?.payload.source==='Outlook email summary') && {mailSummary:true,shareSummary,mailRef:context.mailRef})})
      editing=null;current=draft.id;await refresh()
    })
    button(form,'Cancel editing',async()=>{editing=null;render()})
    controls.replaceChildren(form);form.querySelector('input,textarea,select,button')?.focus()
  }
  function card(p) {
    const pl=p.payload
    const section=element('article',undefined,'cw-entry')
    section.append(element('h4',(labels[p.action] || p.action)+' · '+claimId),
      element('p',(pl.destination || 'Mock Juris')+' · revision '+pl.expectedRevision+' · '+(p.operationState || p.status)))
    if(p.creator)section.append(element('small','Prepared by '+p.creator+(p.reviewer?' · Reviewed by '+p.reviewer:'')))
    if(pl.previousValue!==null && pl.previousValue!==undefined)section.append(element('p','Current value · '+formatted(pl.previousValue)))
    for(const [key,value] of Object.entries(pl.values || {filing:pl.filing?.join('\n') || pl.quote}))section.append(element('p',caption(key)+' · '+formatted(value)))
    if(pl.source || pl.documentId)section.append(element('small','Source · '+(pl.source || pl.documentId)))
    if(pl.documentId) {
      const link=element('a','Inspect source');link.href=pdfViewerHref({claimId,documentId:pl.documentId,anchorId:pl.anchorId})
      section.append(link)
    }
    if(pl.privateTo)section.append(element('p','Private draft until approved or shared for review.'))
    if(p.receiptId)section.append(element('p','Receipt · '+p.receiptId))
    if(p.status==='pending' && state.canAct) {
      const decide=async decision=>{
        await request('proposals/'+p.id+'/review',{decision,expectedVersion:p.version,expectedDigest:p.digest})
        current=p.id; await refresh();await onChange?.()
      }
      button(section,approvals[p.action] || 'Approve exact proposal',()=>decide('approve'))
      if(pl.values && p.action!=='request_wages')button(section,'Edit draft',async()=>editor(p.action,p))
      button(section,'Discard',()=>decide('reject'))
    }
    if(p.operationState==='unknown' && state.canAct)button(section,'Check destination receipt',async()=>{
      await request('operations/'+p.operationId+'/reconcile',{});await refresh()
    })
    controls.append(section)
  }
  function render() {
    if(editing)return
    controls.replaceChildren()
    const options=state.actions
    const order=context.suggestions || options
    const choices=workbench?options:order.filter(a=>a==='status'||a==='review_wages' && state.reviews.some(p=>p.action==='record_wage_evidence' && p.status==='pending')||options.includes(a)).slice(0,3)
    for(const a of choices)button(controls,labels[a],async()=>{
      if(a==='review_wages'){current=state.reviews.find(p=>p.action==='record_wage_evidence' && p.status==='pending')?.id;render();return}
      if(a==='status'){statusOnly=true;await refresh();return}
      if(a==='request_wages'){
        const p=await request('items/'+claimId+'/prepare',{action:a,expectedVersion:state.version})
        current=p.id;await refresh()
      } else editor(a)
    })
    if(state.wages.length && (statusOnly || workbench)) for(const w of state.wages)
      controls.append(element('p','Wage request · '+w.state+(w.taskId?' · '+w.taskId:'')))
    for(const p of state.reviews.filter(p=>workbench||statusOnly||p.id===current))card(p)
    if(current || statusOnly || workbench)button(controls,'Refresh action status',refresh)
  }
  root.replaceChildren(controls,message)
  refresh().then(()=>{if(live && context.autoEdit && state?.actions.includes(context.autoEdit))editor(context.autoEdit)}).catch(e=>{if(live)message.textContent=e.message})
  return ()=>{live=false}
}

/** The shared note starts as a private summary of a single message the employee opened. */
export function createMailNoteControl(React) {
  return function MailNote({session,turnId,answer,csrf}) {
    const matches=[...new Set((answer.items?.[0]?.subject || '').match(/\bCLM-\d{6}\b/g)||[])]
    const [claim,setClaim]=React.useState(matches.length===1?matches[0]:'')
    const [draft,setDraft]=React.useState(null),[busy,setBusy]=React.useState(false),[error,setError]=React.useState('')
    const root=React.useRef(null)
    React.useEffect(()=>{
      if (!draft)return
      return mountActionReview(root.current,{claimId:draft.claimId,csrf,context:{
        autoEdit:'add_note',suggestions:['add_note','create_diary'],mailSummary:true,mailRef:{session,turnId},note:draft.summary}})
    },[draft,csrf,session,turnId])
    const h=React.createElement
    async function prepare() {
      if (busy)return
      setBusy(true);setError('')
      try {
        const view=await actionRequest('items/'+encodeURIComponent(claim)+'/actions')
        if (!view.actions.includes('add_note'))throw Error('Choose a claim you can update.')
        const data=await actionRequest('mail-chat/'+encodeURIComponent(session),{summaryOf:turnId},csrf)
        setDraft({claimId:claim,summary:data.summary})
      } catch(e){setError(e.message)} finally {setBusy(false)}
    }
    return h('section',{'aria-label':'Draft a contact note'},draft ? h('div',{ref:root}) :
      h('label',null,'Target claim ',h('input',{value:claim,onChange:e=>setClaim(e.target.value.trim().toUpperCase()),placeholder:'CLM-000020'}),
        h('button',{type:'button',disabled:busy||!/^CLM-\d{6}$/.test(claim),onClick:prepare},busy?'Preparing summary…':'Draft contact note')),
      error && h('p',{role:'alert'},error))
  }
}
