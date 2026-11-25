import { access } from 'node:fs/promises'

const response = await fetch('http://127.0.0.1:8381/', { signal: AbortSignal.timeout(2500) })
await response.body?.cancel()
await access('/data/config/provider.json')
