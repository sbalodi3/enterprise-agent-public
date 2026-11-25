// @vitest-environment jsdom
/** Portaled menus keep the card attached to the trigger across browser engines. */
import { useRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { Menu } from '../src/Menu.tsx'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('Menu portal anchors', () => {
  it('registers only the external trigger as its anchor', () => {
    function Fixture() {
      const trigger = useRef<HTMLButtonElement>(null)
      return <><button ref={trigger}>Tools</button>
        <Menu open portal anchor={null} anchorRef={trigger}
          items={[{ id: 'one', label: 'One' }]} onClose={vi.fn()} /></>
    }
    const view = render(<Fixture />)
    const trigger = view.getByRole('button', { name: 'Tools' })
    const name = view.getByRole('menu').style.positionAnchor
    expect(name).not.toBe('')
    expect([...document.querySelectorAll<HTMLElement>('[style]')]
      .filter(node => node.style.anchorName === name)).toEqual([trigger])
  })

  it('enables anchor-width matching and clears it when the option is removed', () => {
    const props = { open: true, portal: true, align: 'end' as const, anchor: <button>Tools</button>, onClose: vi.fn() }
    const view = render(<Menu {...props} minWidthFromAnchor items={[{ id: 'one', label: 'One' }]} />)
    const menu = view.getByRole('menu')
    expect(menu.hasAttribute('data-match-anchor-width')).toBe(true)
    expect(menu.style.minWidth).toBe('')
    expect(menu.style.positionAnchor).not.toBe('')
    view.rerender(<Menu {...props} items={[{ id: 'one', label: 'One' }]} />)
    expect(view.getByRole('menu').hasAttribute('data-match-anchor-width')).toBe(false)
  })

  it('keeps matching declarative when the visual viewport is narrower than its anchor', () => {
    vi.stubGlobal('CSS', { supports: () => true })
    const readRect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    vi.stubGlobal('visualViewport', Object.assign(new EventTarget(), {
      width: 200, height: 400, offsetLeft: 40, offsetTop: 60,
    }))
    const view = render(<Menu open portal minWidthFromAnchor align="end" anchor={<button style={{ width: 280 }}>Tools</button>}
      items={[{ id: 'one', label: 'One' }]} onClose={vi.fn()} />)
    const menu = view.getByRole('menu')
    expect(menu.hasAttribute('data-match-anchor-width')).toBe(true)
    expect(menu.style.minWidth).toBe('')
    expect(menu.style.left).toBe('')
    expect(readRect).not.toHaveBeenCalled()
  })

  it('places the footer card above the button and follows scrolling without CSS anchors', () => {
    vi.stubGlobal('CSS', { supports: () => false })
    vi.stubGlobal('innerHeight', 900)
    let anchorTop = 858
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.getAttribute('role') === 'menu'
        ? new DOMRect(0, 12, 144, 128) : new DOMRect(8, anchorTop, 264, 32)
    })
    const view = render(<Menu open portal side="top" anchor={<button>More</button>}
      items={[{ id: 'settings', label: 'Settings' }]} onClose={vi.fn()} />)
    const list = view.getByRole('menu')
    expect(list.parentElement).toBe(document.body)
    expect(list.style.top).toContain('726px')
    expect(list.style.left).toBe('12px')
    anchorTop = 800
    window.dispatchEvent(new Event('scroll'))
    expect(list.style.top).toContain('668px')
  })

  it('flips a card below the upper sidebar button when its preferred side is full', () => {
    vi.stubGlobal('CSS', { supports: () => false })
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.getAttribute('role') === 'menu'
        ? new DOMRect(0, 12, 144, 128) : new DOMRect(32, 70, 144, 32)
    })
    const view = render(<Menu open portal side="top" anchor={<button>More</button>}
      items={[{ id: 'one', label: 'One' }]} onClose={vi.fn()} />)
    expect(view.getByRole('menu').style.top).toContain('106px')
  })
})
