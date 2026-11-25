import { createHash } from 'node:crypto'

export const cmsRevision = 'bfa4bfceeb0a9b73a88b7a4f7ab82704a043341e'
export const cmsSource = 'https://github.com/sebastianhema/CMS-MCP'
export const cmsSnapshotPath = '/run/cms-mcp/snapshot.json'
// Digest of the ordered, joined source rows produced by the pinned SQL.
export const expectedRowsDigest = '9e697d7de0f2ef313564863b565ccd3a041ab9b955ea41ad05c4b404e1a0da68'
export const sha256 = text => createHash('sha256').update(text).digest('hex')

export function validateSnapshot(snapshot) {
  if (snapshot?.source !== cmsSource || snapshot.revision !== cmsRevision || snapshot.format !== 1 ||
      !Array.isArray(snapshot.rows) || snapshot.rows.length !== 200 ||
      !Number.isFinite(Date.parse(snapshot.extractedAt)) || snapshot.extractedAt !== new Date(snapshot.extractedAt).toISOString() ||
      snapshot.digest !== expectedRowsDigest || sha256(JSON.stringify(snapshot.rows)) !== expectedRowsDigest)
    throw new Error('Invalid CMS-MCP snapshot. Regenerate it from the pinned checkout.')
  return snapshot
}
