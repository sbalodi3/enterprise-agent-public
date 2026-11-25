// Apply employee-specific token limits to the deployment's trusted local model.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const { parse } = createRequire(new URL('../../packages/boot/config-editor/package.json', import.meta.url))('yaml')

export function employeeProvider(subject) {
  return 'claims-employee-' + createHash('sha256').update(subject).digest('hex').slice(0, 32)
}

export function localSelection(ctx, subject) {
  const base = ctx.agentDefaultModel.currentSelection()
  const provider = employeeProvider(subject)
  return ctx.llm.listProviders().some(item => item.id === provider) ? { ...base, provider } : base
}

function readLimits(rows, modelId, limits) {
  if (!Array.isArray(rows)) return
  for (const row of rows) {
    if (!row || row.disabled) continue
    if (row.id === 'llm-pi-ai') {
      const models = row.config?.providers?.['claims-local']?.models
      const model = Array.isArray(models) && models.find(item => item.id === modelId)
      if (model) {
        for (const key of ['contextWindow', 'maxTokens']) {
          if (Number.isSafeInteger(model[key]) && model[key] > 0) limits[key] = model[key]
        }
      }
    }
    readLimits(row.insert, modelId, limits)
    readLimits(row.group, modelId, limits)
  }
}

export async function personalModelProviders(home, roster, base) {
  const providers = {}
  const defaultModel = base.models[0]
  for (const user of roster.employees) {
    const root = join(home, 'native-chat', roster.tenant, user.subject, 'legacy-settings')
    const limits = {}
    for (const patch of ['profiles/claims-desktop-chat/cordis.patch.yml', 'cordis.patch.yml']) {
      let source
      try {
        source = await readFile(join(root, patch), 'utf8')
      } catch (error) {
        if (error.code === 'ENOENT') continue
        throw error
      }
      readLimits(parse(source), defaultModel.id, limits)
    }
    if (Object.entries(limits).some(([key, value]) => defaultModel[key] !== value)) {
      providers[employeeProvider(user.subject)] = { ...base, models: [{ ...defaultModel, ...limits }] }
    }
  }
  return providers
}
