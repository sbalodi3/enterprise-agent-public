import { rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { startMailLab } from '../tests/outlook-emulator/lab.mjs'

const { env, emulator } = await startMailLab(process.env.CLAIMS_APP_ORIGIN, {
  showcase: true,
  cms: process.env.CLAIMS_CMS_MCP === '1',
  hostname: '0.0.0.0',
  containerHost: 'outlook',
  port: 8381,
  graphPort: 8382,
  baseUrl: process.env.CLAIMS_OUTLOOK_ORIGIN || 'http://127.0.0.1:8381',
})
const temporary = '/data/config/provider-' + randomUUID()
await writeFile(temporary, JSON.stringify(env), { flag: 'wx', mode: 0o600 })
await rename(temporary, '/data/config/provider.json')
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    void emulator.close()
  })
