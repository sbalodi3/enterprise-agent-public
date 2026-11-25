/** External browser admission never falls back to launch-token owner access. */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, inject, HostConnectionService, type ConnectionIndexResponse } from '../src/index.ts'
import { provideBrowserCredentials } from './browser-credentials.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap {
    'external-auth-test': { readonly kind: 'external-auth-test'; readonly subject: string }
  }
}

const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })

async function mounted(authentication: 'browser-token' | 'external' = 'external') {
  const ctx = new Context()
  contexts.push(ctx)
  provideBrowserCredentials(ctx)
  await ctx.plugin({ inject: [...inject], apply }, { authentication })
  return { ctx, connection: ctx.connection as HostConnectionService }
}

function response() {
  const writeHead = vi.fn(), end = vi.fn()
  const value: ConnectionIndexResponse = { writeHead, end }
  return { value, writeHead, end }
}

describe('external authentication', () => {
  it('refuses HTTP, index and WebSocket before provider installation and disables owner connect', async () => {
    const { connection } = await mounted()
    const request = { headers: { host: 'localhost:3080' }, method: 'GET', url: '/' }
    expect(connection.admit(request)).toEqual({ rejection: 401 })
    expect(connection.admitConnection(request)).toEqual({ rejection: 401 })
    expect(connection.authenticatedUrl('http://localhost:3080/')).toBe('http://localhost:3080/')
    const index = response()
    expect(connection.authorizeIndex(request, index.value)).toBe(false)
    expect(index.writeHead).toHaveBeenCalledWith(401)
    const connect = response()
    connection.authorizeConnect(request, connect.value)
    expect(connect.writeHead).toHaveBeenCalledWith(403)
  })

  it('admits the provider Peer consistently, preserves trust checks and closes after revocation', async () => {
    const { connection } = await mounted()
    const peer = connection.createPeer({ principal: { kind: 'external-auth-test', subject: 'alice' } })
    const admit = vi.fn(() => ({ peer }))
    const authorizeIndex = vi.fn(() => true)
    const remove = connection.registerAdmissionProvider({ admit, authorizeIndex })
    const request = { headers: { host: 'localhost:3080' } }
    expect(connection.admit(request)).toEqual({ peer })
    const socket = connection.admitConnection(request)
    expect('peer' in socket && socket.peer).toBe(peer)
    if ('release' in socket) await socket.release()
    expect(peer.signal.aborted).toBe(false)
    expect(connection.admit({ headers: { host: 'evil.invalid' } })).toEqual({ rejection: 403 })
    expect(admit).toHaveBeenCalledTimes(2)
    expect(connection.authorizeIndex(request, response().value)).toBe(true)
    expect(() => connection.registerAdmissionProvider({ admit, authorizeIndex })).toThrow('already registered')
    await peer.dispose()
    expect(connection.admit(request)).toEqual({ rejection: 401 })
    await remove()
    expect(connection.admit(request)).toEqual({ rejection: 401 })
    expect(connection.authorizeIndex(request, response().value)).toBe(false)
  })

  it('cannot install external authentication into the default owner profile', async () => {
    const { connection } = await mounted('browser-token')
    expect(() => connection.registerAdmissionProvider({ admit: () => ({ rejection: 401 }), authorizeIndex: () => false })).toThrow('must be configured')
    expect(connection.authenticatedUrl('http://localhost:3080/')).toContain('token=')
  })
})
