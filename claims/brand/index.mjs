import { readFile } from 'node:fs/promises'

export const inject = ['webServer']
const product = 'Enterprise Agent'

export async function apply(ctx) {
  const manifest = {
    name: product, short_name: product, start_url: '/', scope: '/', display: 'standalone',
    background_color: '#182448', theme_color: '#182448',
    icons: [192, 512].map(size => ({ src: '/icon-' + size + '.png', sizes: size + 'x' + size, type: 'image/png' })),
  }
  manifest.icons.push({ src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' })
  const assets = [
    ['/manifest.webmanifest', 'application/manifest+json', Buffer.from(JSON.stringify(manifest))],
  ]
  for (const [file, paths, type] of [
    ['mark.svg', ['/favicon.svg', '/favicon-dark.svg'], 'image/svg+xml'],
    ['touch.png', ['/apple-touch-icon.png'], 'image/png'],
    ['icon-192.png', ['/icon-192.png'], 'image/png'],
    ['icon-512.png', ['/icon-512.png'], 'image/png'],
    ['maskable.png', ['/icon-maskable-512.png'], 'image/png'],
  ]) {
    const data = await readFile(new URL(file, import.meta.url))
    for (const path of paths) assets.push([path, type, data])
  }
  for (const [path, type, data] of assets) {
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path, handler(req, res) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return res.writeHead(405, { allow: 'GET, HEAD' }).end()
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' })
      res.end(req.method === 'HEAD' ? undefined : data)
    } }), 'enterprise-agent: ' + path)
  }
  ctx.effect(() => ctx.webServer.tapIndex(html => html
    .replace(/<title>[^<]*<\/title>/i, '<title>' + product + '</title><meta name="application-name" content="' + product + '">')
    .replace(/(<meta name="apple-mobile-web-app-title" content=")[^"]*/i, '$1' + product)
  ), 'enterprise-agent: page metadata')
}
