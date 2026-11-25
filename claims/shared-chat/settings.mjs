import { RemoteError } from '../../packages/typert/protocol/lib/index.js'
import { FONT_SIZE_SPECS, THEME_PREFERENCES } from '../../packages/client/ui-theme/lib/types/theme-settings.js'

const theme = 'ui-theme'
const welcome = 'ui-settings-general'
const namespaces = new Set([theme,welcome])
const key = (subject,ns) => subject+'/'+ns
const fonts = new Set(['textFontFamily','codeFontFamily','terminalFontFamily'])
const sizes = new Map(Object.values(FONT_SIZE_SPECS).map(spec=>[spec.field,spec]))
function valid(ns,field,value) {
  if (ns===welcome) return field==='welcomeNoticeVersion' && typeof value==='string' && value.length<=128

  if (field === 'preference') return THEME_PREFERENCES.includes(value)
  if (fonts.has(field)) return typeof value === 'string' && value.length<=256 && /^[\p{L}\p{N} ,"'_-]*$/u.test(value)
  const size = sizes.get(field)
  return size && Number.isInteger(value) && value>=size.min && value<=size.max
}
function rejected() { throw new RemoteError('settings/rejected','Unsupported personal appearance setting',{ns:theme}) }
function apply(ns,current,mode,input) {
  let result = {...current}
  if (mode === 'mutate') {
    if (!Array.isArray(input) || input.length>32) rejected()
    for (const edit of input) {
      if (!Array.isArray(edit.path) || edit.path.length>1 || !['set','unset'].includes(edit.op)) rejected()
      if (!edit.path.length) result=edit.op==='unset'?{}:apply(ns,{},'replace',edit.value)
      else if (edit.op==='unset') delete result[edit.path[0]]
      else {
        if (!valid(ns,edit.path[0],edit.value)) rejected()
        result[edit.path[0]]=edit.value
      }
    }
    return result
  }
  if (!input || Array.isArray(input) || typeof input!=='object' || Object.entries(input).some(([k,v])=>!valid(ns,k,v))) rejected()
  return mode==='replace'?{...input}:{...result,...input}
}
export function personalPreferences(rows) {
  const sections = new Map()
  function visit(entries) {
    for (const row of entries) {
      if (namespaces.has(row?.id) && row.config && !row.disabled) {
        const allowed = Object.fromEntries(Object.entries(row.config).filter(([k,v])=>valid(row.id,k,v)))
        if (Object.keys(allowed).length) sections.set(row.id,{...sections.get(row.id),...allowed})
      }
      if (Array.isArray(row?.insert)) visit(row.insert)
    }
  }
  if (Array.isArray(rows)) visit(rows)
  return sections
}
export async function employeeSettings(pool,deployment) {
  const cache=new Map()
  const rows=await pool.query('SELECT subject,namespace,preferences,revision FROM cw_native_chat_preferences WHERE deployment=$1',[deployment])
  for (const row of rows.rows) cache.set(key(row.subject,row.namespace),row)
  function view(subject,descriptor) {
    const {preferences,revision}=cache.get(key(subject,descriptor.ns)) || {preferences:{},revision:0}
    const base=descriptor.base ?? descriptor.value
    return {...descriptor,base,value:{...base,...preferences},user:preferences,revision,secrets:[]}
  }
  return {
    describe(principal,descriptors) {
      const visible=descriptors.filter(row=>namespaces.has(row.ns) && principal.kind==='claims-user')
      return {writable:true,hasDocument:false,namespaces:visible.map(row=>view(principal.subject,row))}
    },
    async write(principal,descriptor,mode,input,expected) {
      if (principal.kind!=='claims-user' || !namespaces.has(descriptor.ns)) rejected()
      const ns=descriptor.ns, entry=key(principal.subject,ns)
      const args=[deployment,principal.subject,ns]
      const db=await pool.connect()
      try {
        await db.query('BEGIN')
        await db.query('INSERT INTO cw_native_chat_preferences(deployment,subject,namespace) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',args)
        const row=(await db.query('SELECT preferences,revision FROM cw_native_chat_preferences WHERE (deployment,subject,namespace)=($1,$2,$3) FOR UPDATE',args)).rows[0]
        if(expected!==undefined && expected!==row.revision) throw new RemoteError('settings/conflict','Personal settings changed',{ns,expected,actual:row.revision})
        const preferences=apply(ns,row.preferences,mode,input),revision=row.revision+1
        await db.query('UPDATE cw_native_chat_preferences SET preferences=$4,revision=$5 WHERE (deployment,subject,namespace)=($1,$2,$3)',[...args,JSON.stringify(preferences),revision])
        await db.query('COMMIT')
        if((cache.get(entry)?.revision ?? -1)<revision)cache.set(entry,{preferences,revision})
        return view(principal.subject,descriptor)
      } catch (error) { await db.query('ROLLBACK');throw error }
      finally { db.release() }
    },
  }
}
