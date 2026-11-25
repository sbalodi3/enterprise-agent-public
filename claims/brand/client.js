window.__ModuleLoader__.load({
  id: '@local/enterprise-agent-brand',
  factory(require) {
    const h = require('react').createElement
    function Mark({ size, className }) {
      return h('img', { src: '/favicon.svg', width: size, height: size, className, alt: '' })
    }
    function Wordmark() {
      return h('span', { style: { fontSize: 16, fontWeight: 650, letterSpacing: '-0.035em', whiteSpace: 'nowrap' } }, 'Enterprise Agent')
    }
    return {
      inject: ['slots'],
      apply(ctx) {
        for (const [name, component] of [
          ['sidebar.brand.mark', Mark],
          ['sidebar.brand.name', Wordmark],
          ['conversation.hero.brand.mark', Mark],
          ['conversation.hero.brand.name', () => 'Enterprise Agent'],
        ]) {
          ctx.slots.inject(name, () => ctx.slots.register({ name }, component))
        }
      },
    }
  },
})
