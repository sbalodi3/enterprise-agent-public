import { networkInterfaces } from 'node:os'
import { createSocket } from 'node:dgram'

export function containerAddress(interfaces = networkInterfaces(), name = process.env.CLAIMS_BIND_INTERFACE) {
  const entries = name ? interfaces[name] ?? [] : Object.values(interfaces).flat()
  return entries.find(entry => entry?.family === 'IPv4' && !entry.internal)?.address
}

// Let the OS choose the local interface for a peer on the ingress network.
// Connecting a UDP socket selects the route without sending a packet.
export async function resolveContainerAddress(peer = process.env.CLAIMS_BIND_PEER) {
  if (!peer || process.env.CLAIMS_BIND_INTERFACE) return containerAddress()
  const socket = createSocket('udp4')
  try {
    await new Promise((resolve, reject) => {
      socket.once('error', reject)
      socket.connect(9, peer, resolve)
    })
    const address = socket.address().address
    if (Object.values(networkInterfaces()).flat().some(entry => entry?.address === address && !entry.internal))
      return address
    throw new Error('No private container interface can reach ' + peer)
  } finally {
    socket.close()
  }
}
