import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { loginHref } from '../auth/destinations.mjs'
import { pdfReference, pdfViewerHref } from '../ui/pdf-link.mjs'

const viewer = `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Claim PDF · Enterprise Agent</title>
<link rel="stylesheet" href="/claims/assets/claim-pdf.css"><main class="claims-pdf">
<header><h1>Claim document</h1><nav aria-label="Document actions"><button id="download" disabled>Download</button>
<a id="new-tab" target="_blank" rel="noopener noreferrer" hidden>Open in new tab</a></nav></header>
<p id="status" role="status">Loading document…</p><a id="sign-in" target="_top" hidden>Sign in to reopen this PDF</a>
<section id="pages" aria-label="Document pages"></section></main><script type="module" src="/claims/assets/claim-pdf.mjs"></script></html>`

export async function registerPdfViewer(ctx, assets) {
  const require = createRequire(new URL('../../packages/client/ui-sidebar-documentpreview/package.json', import.meta.url))
  for (const name of ['pdf.min.mjs', 'pdf.worker.min.mjs']) {
    const body = await readFile(require.resolve('pdfjs-dist/legacy/build/' + name))
    assets.set('/claims/assets/' + name, { type: 'text/javascript', body })
  }
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix', path: '/claims/view-pdf',
    handler(req, res) {
      const url = new URL(req.url, 'http://localhost')
      const headers = {
        'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'content-type': 'text/html; charset=utf-8',
        'x-content-type-options': 'nosniff', 'x-frame-options': 'SAMEORIGIN',
        'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; worker-src 'self'; connect-src 'self'; font-src blob:; frame-ancestors 'self'; base-uri 'none'; form-action 'none'",
      }
      const ref = pdfReference(url.searchParams)
      if (req.method !== 'GET' || url.pathname !== '/claims/view-pdf' || !ref) return res.writeHead(404, headers).end('Document unavailable.')
      const admission = ctx.claimsAuth.admit(req)
      if (admission.rejection === 401) {
        const location = loginHref(pdfViewerHref(ref))
        if (req.headers['sec-fetch-dest'] === 'iframe') return res.writeHead(401, headers)
          .end('<p>Your sign-in has ended. <a target="_top" href="' + location + '">Sign in to reopen this PDF</a></p>')
        return res.writeHead(303, { ...headers, location }).end()
      }
      if (admission.rejection) return res.writeHead(403, headers).end('Document access denied.')
      res.writeHead(200, headers).end(viewer)
    },
  }), 'claims: protected PDF viewer')
}
