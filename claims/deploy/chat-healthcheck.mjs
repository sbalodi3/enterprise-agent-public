// Probe a protected API on the gateway. A healthy anonymous request gets 401.
import http from 'node:http'
import { networkInterfaces } from 'node:os'
const port = Number(process.env.CLAIMS_DESKTOP_PORT)
const hostname = Object.values(networkInterfaces()).flat().find(entry => entry?.family === 'IPv4' && !entry.internal)?.address
if (!hostname) throw new Error('No concrete container IPv4 interface is available')
const request = http.get({
  hostname, port, path: '/api', headers: { host: new URL(process.env.CLAIMS_APP_ORIGIN || 'http://localhost:3080').hostname + ':' + port },
  signal: AbortSignal.timeout(3000),
}, response => {
  response.resume()
  if (response.statusCode !== 401) process.exitCode = 1
})
request.on('error', () => { process.exitCode = 1 })
