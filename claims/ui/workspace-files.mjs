export function workspaceFiles(React) {
  const h=React.createElement
  return function Files() {
    const [folder,setFolder]=React.useState(''),[entries,setEntries]=React.useState([])
    const [file,setFile]=React.useState(null),[error,setError]=React.useState(''),[busy,setBusy]=React.useState(false)
    const [uploads,setUploads]=React.useState([])
    const active=React.useRef()
    React.useEffect(()=>{
      const controller=new AbortController()
      fetch('/chat/uploads',{signal:controller.signal,cache:'no-store'}).then(async response=>{
        if(!response.ok)throw Error('Could not load your Chat uploads.')
        const rows=await response.json()
        if(!controller.signal.aborted)setUploads(rows)
      }).catch(error=>{if(!controller.signal.aborted)setError(error.message)})
      return ()=>controller.abort()
    },[])
    React.useEffect(()=>()=>active.current?.abort(),[])
    async function load(path,read=false) {
      active.current?.abort()
      const controller=new AbortController()
      active.current=controller
      setBusy(true);setError('')
      try {
        const query=new URLSearchParams({path,...(read&&{read:'1'})})
        const response=await fetch('/chat/files?'+query,{cache:'no-store',signal:controller.signal})
        if(!response.ok)throw Error('Could not open the workspace file or directory.')
        const value=await response.json()
        if(read) {
          const bytes=Uint8Array.from(atob(value.data),c=>c.charCodeAt(0))
          let text
          try {text=new TextDecoder('utf-8',{fatal:true}).decode(bytes)} catch {}
          setFile({path,bytes,text})
        } else {setFolder(path);setEntries(value.entries);setFile(null)}
      } catch(e) {if(!controller.signal.aborted)setError(e.message)}
      finally {if(!controller.signal.aborted)setBusy(false)}
    }
    React.useEffect(()=>{void load('')},[])
    async function save() {
      setBusy(true);setError('')
      try {
        const me=await fetch('/auth/me',{cache:'no-store'}),{csrfToken}=await me.json()
        const result=await fetch('/chat/files?'+new URLSearchParams({path:file.path}),{
          method:'POST',headers:{'X-CSRF-Token':csrfToken},body:file.text})
        if(!result.ok)throw Error('File could not be saved.')
        await load(folder)
      }catch(e){setError(e.message)}finally{setBusy(false)}
    }
    function download(){
      const url=URL.createObjectURL(new Blob([file.bytes]))
      const anchor=document.createElement('a');anchor.href=url;anchor.download=file.path.split('/').at(-1);anchor.click()
      setTimeout(()=>URL.revokeObjectURL(url),1000)
    }
    return h('section',{'aria-label':'Workspace files',style:{padding:20,overflow:'auto'}},h('h2',{},'Workspace files'),
      !file && !folder && uploads.length>0 && h('section',{'aria-label':'Chat uploads'},
        h('h3',{},'Chat uploads'),h('ul',{},uploads.map(item=>h('li',{key:item.id},
          h('a',{href:'/chat/uploads?'+new URLSearchParams({id:item.id}),download:item.name},item.name))))),
      h('p',{},file?.path || '/'+folder),
      busy&&h('p',{role:'status'},'Opening workspace…'),error&&h('p',{role:'alert'},error),
      file ? h(React.Fragment,{},h('button',{onClick:()=>load(folder)},'Back to folder'),
        h('button',{onClick:download},'Download'),
        file.text!==undefined && h('div',{},h('textarea',{'aria-label':'File contents',value:file.text,rows:18,
          onChange:e=>setFile({...file,text:e.target.value})}),h('button',{onClick:save,disabled:busy},'Save file'))) :
      h(React.Fragment,{},folder&&h('button',{onClick:()=>load(folder.split('/').slice(0,-1).join('/'))},'Parent folder'),
        h('ul',{},entries.map(item=>h('li',{key:item.name},h('button',{onClick:()=>load([folder,item.name].filter(Boolean).join('/'),!item.directory)},item.name+(item.directory?'/':'')))))))
  }
}
