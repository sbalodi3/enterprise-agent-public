// Commit an origin-local document before native authentication checks Fetch Metadata.
// Both destinations are fixed. The entry never transfers a login token or a claim ID.
export function registerPageEntry(ctx, path, destination) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix', path,
    handler(req, res) {
      if (req.method !== 'GET' || req.url !== path) { res.writeHead(404).end(); return }
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
      })
      res.end('<!doctype html><title>Opening Enterprise Agent</title><meta http-equiv="refresh" content="0;url='+destination+'"><a href="'+destination+'">Continue</a>')
    },
  }), 'claims: page navigation')
}
