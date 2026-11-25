const lists = ['session/list', 'session/search', 'session/control', 'workspace/follow']
const create = 'session/create'
const global = { kind: 'global' }
function binding(resource, actions) {
  return { role: { name: 'employee-' + resource.kind, resource: resource.kind, actions }, resource }
}
const personalSettings = ['settings/describe','settings/update','settings/replace','settings/mutate']
const globalGrant = binding(global, [...lists, create, 'session/modelCatalog', ...personalSettings])
const sessionActions = [...lists, create, 'session/events', 'session/follow', 'session/page', 'session/state',
  'session/observeState', 'session/observeEvent', 'session/observeProjections', 'session/projections',
  'session/prompt', 'session/cancel', 'session/rename', 'fileUploads/upload', 'session/attachment', 'session/updateQueue',
  ...['environment','shells','list','create','watch','retain','attach','rename','close','readScreen','inspectActivity'].map(name=>'terminal/'+name),
  ...['activity','added','error','removed','status'].map(name => 'event:api-session/' + name)]
const departmentSessionActions = sessionActions.filter(action =>
  !action.startsWith('terminal/') && !['session/prompt', 'fileUploads/upload', 'session/attachment', 'session/updateQueue'].includes(action))
const workspaceActions = ['workspace/follow', create]

/** Native IDs are immutable. Cache grants only after the database confirms the exact owner. */
export async function nativeOwnership(pool, deployment) {
  const owners = new Map(), profiles = new Map()
  const grants = new Map(), tools = new Map()
  function rememberTool(subject, name, config) {
    if (!tools.has(subject)) tools.set(subject,new Map())
    tools.get(subject).set(name,config)
  }
  const configured = await pool.query('SELECT subject,name,configuration FROM cw_native_chat_tools WHERE deployment=$1',[deployment])
  for (const row of configured.rows) rememberTool(row.subject,row.name,row.configuration)
  function remember(subject, kind, id, profile) {
    const key = kind + ':' + id
    if (owners.has(key)) {
      if (owners.get(key) !== subject || profiles.get(key) !== profile) throw Error('Conflicting native Chat ownership')
      return
    }
    owners.set(key, subject)
    profiles.set(key, profile)
    const group = subject + '/' + profile
    if (!grants.has(group)) grants.set(group, [])
    const actions = kind === 'workspace' ? workspaceActions : profile === 'claims' ? sessionActions : departmentSessionActions
    grants.get(group).push(binding({ kind, id }, actions))
  }
  const rows = await pool.query('SELECT subject, kind, native_id, chat_profile FROM cw_native_chat_resources WHERE deployment=$1', [deployment])
  for (const row of rows.rows) remember(row.subject, row.kind, row.native_id, row.chat_profile)
  return {
    async bind(subject, kind, id, profile = 'claims') {
      const args = [deployment, subject, kind, id, profile]
      await pool.query('INSERT INTO cw_native_chat_resources(deployment, subject, kind, native_id, chat_profile) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', args)
      const result = await pool.query('SELECT 1 FROM cw_native_chat_resources WHERE (deployment,subject,kind,native_id,chat_profile)=($1,$2,$3,$4,$5)', args)
      if (!result.rowCount) throw Error('Conflicting native Chat ownership')
      remember(subject, kind, id, profile)
    },
    async bindTool(subject, name, config) {
      const args = [deployment,subject,name,JSON.stringify(config)]
      await pool.query('INSERT INTO cw_native_chat_tools VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING',args)
      const {rowCount} = await pool.query('SELECT 1 FROM cw_native_chat_tools WHERE (deployment,subject,name,configuration)=($1,$2,$3,$4::jsonb)',args)
      if (!rowCount) throw Error('Conflicting employee tool configuration')
      rememberTool(subject,name,config)
    },
    async bindPreferences(subject,namespace,preferences) {
      await pool.query('INSERT INTO cw_native_chat_preferences(deployment,subject,namespace,preferences) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
        [deployment,subject,namespace,JSON.stringify(preferences)])
    },
    async preferences(subject) {
      return (await pool.query('SELECT namespace,preferences,revision FROM cw_native_chat_preferences WHERE deployment=$1 AND subject=$2',[deployment,subject])).rows
    },
    async bindUpload(subject,kind,ref) {
      const name=ref.name || 'Image'
      await pool.query('INSERT INTO cw_native_chat_uploads(deployment,subject,kind,digest,display_name,reference) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(deployment,subject,kind,digest,display_name) DO NOTHING',
        [deployment,subject,kind,ref.attachmentId,name,JSON.stringify(ref)])
    },
    async uploads(subject) {
      return (await pool.query('SELECT id,kind,display_name AS name FROM cw_native_chat_uploads WHERE deployment=$1 AND subject=$2 ORDER BY display_name,id',[deployment,subject])).rows
    },
    async upload(subject,id) {
      return (await pool.query('SELECT kind,reference FROM cw_native_chat_uploads WHERE deployment=$1 AND subject=$2 AND id=$3',[deployment,subject,id])).rows[0]
    },
    toolsFor(subject) { return new Map(tools.get(subject)) },
    owner(kind, id) { return owners.get(kind + ':' + id) },
    profile(kind, id) { return profiles.get(kind + ':' + id) },
    belongs(principal, kind, id) {
      const key = kind + ':' + id
      return owners.get(key) === principal.subject && profiles.get(key) === (principal.department || 'claims')
    },
    bindings(principal) {
      if (principal.kind !== 'claims-user') return []
      return [globalGrant, ...(grants.get(principal.subject + '/' + (principal.department || 'claims')) ?? [])]
    },
  }
}
