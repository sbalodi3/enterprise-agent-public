import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

// Explicit opt-in, official Apache-2.0 model; the revision and LFS SHA256 are immutable.
const revision = 'bc640142c66e1fdd12af0bd68f40445458f3869b'
const sha256 = '7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5'
const url = `https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/${revision}/Qwen3-4B-Q4_K_M.gguf`
const directory = fileURLToPath(new URL('./models/', import.meta.url))
const target = fileURLToPath(new URL('./models/Qwen3-4B-Q4_K_M.gguf', import.meta.url))
await mkdir(directory, { recursive: true })
const digest = async path => {
  const hash = createHash('sha256')
  for await (const part of createReadStream(path)) hash.update(part)
  return hash.digest('hex')
}
if (await stat(target).catch(error => { if (error.code !== 'ENOENT') throw error })) {
  if (await digest(target) !== sha256) throw new Error('Existing reference model has a different digest; refusing to replace it')
  console.log('Pinned Qwen3-4B reference model already present; SHA256 verified.')
} else {
  const temporary = `${target}.partial-${process.pid}`
  try {
    console.log('Downloading official Qwen3-4B Q4_K_M (2.50 GB) into the ignored model directory.')
    const response = await fetch(url, { signal: AbortSignal.timeout(1800000) })
    if (!response.ok || !response.body) throw new Error(`Model download failed: HTTP ${response.status}`)
    const hash = createHash('sha256')
    const checksum = new Transform({ transform(chunk, encoding, callback) { hash.update(chunk); callback(null, chunk) } })
    await pipeline(Readable.fromWeb(response.body), checksum, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }))
    if (hash.digest('hex') !== sha256) throw new Error('Downloaded model SHA256 does not match the pinned official artifact')
    await rename(temporary, target)
    console.log('Model downloaded and pinned SHA256 verified. Start the optional model profile to serve it locally.')
  } finally { await rm(temporary, { force: true }) }
}
