import { resolveContainerAddress } from '../runtime/bind-address.mjs'

const address = process.env.CLAIMS_BIND_HOST || await resolveContainerAddress()
if (!address) throw new Error('No concrete container IPv4 interface is available')
const response = await fetch(`http://${address}:${process.env.CLAIMS_PORT ?? '3080'}/health/ready`, { signal: AbortSignal.timeout(3000) })
if (!response.ok) throw new Error(`Work API readiness returned HTTP ${response.status}`)
if (!response.headers.get('content-type')?.startsWith('application/json') || (await response.json()).ready !== true)
  throw new Error('Workbench API has not registered its readiness endpoint')
