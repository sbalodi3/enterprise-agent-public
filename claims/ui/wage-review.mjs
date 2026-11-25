import { A2uiSurface, A2uiLitElement } from '@a2ui/lit'
import { Catalog } from '@a2ui/web_core/catalog'
import { MessageProcessor, basicCatalog } from '@a2ui/web_core/v1_0'
import { css, html } from 'lit'
import { z } from 'zod'

const id = 'urn:claims:wage-review:v1'
const labels = { Coverage: 'Coverage', Gap: 'Evidence gap', Disagreement: 'Conflicting accounts' }
const entries = Object.entries(labels).map(([name, label]) => {
  const api = { name, schema: z.object({ text: z.string() }) }
  class ReviewFact extends A2uiLitElement {
    api = api
    static styles = css`:host{display:block}p{margin:.15rem 0;overflow-wrap:anywhere}strong{font-size:.875em}`
    render() { return html`<strong>${label}</strong><p>${this.controller?.props?.text}</p>` }
  }
  return { ...api, tagName: 'claims-wage-' + name.toLowerCase(), element: ReviewFact }
})
const sourceApi = { name: 'SourceLink', schema: z.object({ label: z.string(), index: z.number().int().nonnegative() }) }
class ReviewSource extends A2uiLitElement {
  api = sourceApi
  static styles = css`button{font:inherit;color:inherit;background:transparent;border:0;text-decoration:underline;cursor:pointer;text-align:start;padding:.2rem 0}`
  render() {
    const props = this.controller?.props
    return html`<button @click=${() => this.dispatchEvent(new CustomEvent('claims-source', {
      bubbles: true, composed: true, detail: props.index,
    }))}>${props?.label}</button>`
  }
}
const catalog = new Catalog(id, '1.0', [basicCatalog.components.get('Column'), ...entries,
  { ...sourceApi, tagName: 'claims-wage-source', element: ReviewSource }])

export function renderReview(root, review, onSource) {
  if (review.version !== 1) throw Error('Unsupported wage review')
  const processor = new MessageProcessor([catalog])
  processor.processMessages(review.messages)
  const view = new A2uiSurface()
  view.surface = processor.getSurface('wage')
  if (!view.surface) throw Error('Missing wage review')
  view.addEventListener('claims-source', e => onSource(e.detail))
  root.replaceChildren(view)
  return () => {
    view.remove()
    processor.processMessages([{ version: '1.0', deleteSurface: { surfaceId: 'wage' } }])
  }
}
