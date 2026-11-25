import http from 'node:http'
import { timingSafeEqual, createHash } from 'node:crypto'
const digest = (s) => createHash('sha256').update(s).digest()
const token = process.env.SHOWCASE_VOICE_TOKEN
if (!token) throw Error('Voice service credential required')
http
  .createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/demo/replay') return res.writeHead(404).end()
    if (!timingSafeEqual(digest(req.headers.authorization || ''), digest('Bearer ' + token)))
      return res.writeHead(403).end()
    try {
      const result = await fetch('http://workbench:3080/claims/integrations/showcase/voice', {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        body: JSON.stringify({ eventId: 'voice-IN-201', documentId: 'IN-201-call' }),
      })
      res.writeHead(result.status, { 'content-type': 'application/json' }).end(await result.text())
    } catch {
      res.writeHead(503).end()
    }
  })
  .listen(3092, '0.0.0.0')
