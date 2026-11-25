import { readFile } from 'node:fs/promises'

const files = {
  'claim-timeline': '../showcase/timeline.html',
  'open-cases': '../ui/open-cases.html',
  'portfolio-summary': '../ui/portfolio-summary.html',
}
// Each resource must work offline inside an opaque iframe. Inline only these bundled files.
const [styles, format, client] = await Promise.all(['widget.css', 'widget-format.mjs', 'widget-client.js']
  .map(file => readFile(new URL('../ui/' + file, import.meta.url), 'utf8')))
export const widgetResources = new Map(await Promise.all(Object.entries(files).map(async ([name, path]) => {
  const template = await readFile(new URL(path, import.meta.url), 'utf8')
  const resource = {
    uri: 'ui://enterprise-agent/' + name + '.html',
    name, mimeType: 'text/html;profile=mcp-app',
    text: template.replace('/* bundled widget styles */', () => styles)
      .replace('/* bundled widget code */', () => format + '\n' + client),
    _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } } },
  }
  return [name, resource]
})))
