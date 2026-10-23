export interface PickedElement {
  url: string
  title: string
  selector: string
  html: string
  truncated: boolean
  rect: { x: number; y: number; width: number; height: number }
}

/** Self-contained so the same function can run inside an isolated Electron guest. */
export function pickElement(doc: Document): Promise<PickedElement | null> {
  doc.dispatchEvent(new Event('beddcode:cancel-element-picker'))
  return new Promise((resolve) => {
    const win = doc.defaultView!
    const overlay = doc.createElement('div')
    overlay.style.cssText =
      'position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #60a5fa;background:rgba(96,165,250,.15);box-sizing:border-box;display:none;'
    doc.documentElement.appendChild(overlay)
    let target: Element | null = null
    const block = (event: Event) => {
      event.preventDefault()
      event.stopImmediatePropagation()
    }
    const finish = (result: PickedElement | null) => {
      clearTimeout(timer)
      overlay.remove()
      doc.removeEventListener('pointermove', move, true)
      doc.removeEventListener('click', click, true)
      doc.removeEventListener('pointerdown', block, true)
      doc.removeEventListener('mousedown', block, true)
      doc.removeEventListener('pointerup', block, true)
      doc.removeEventListener('mouseup', block, true)
      doc.removeEventListener('keydown', key, true)
      doc.removeEventListener('beddcode:cancel-element-picker', cancel)
      win.removeEventListener('pagehide', cancel)
      resolve(result)
    }
    const cancel = () => finish(null)
    const move = (event: PointerEvent) => {
      const element = event.composedPath().find((node) => node instanceof win.Element)
      target = element instanceof win.Element ? element : null
      if (!target) return
      const r = target.getBoundingClientRect()
      Object.assign(overlay.style, {
        display: 'block',
        left: `${r.left}px`,
        top: `${r.top}px`,
        width: `${r.width}px`,
        height: `${r.height}px`,
      })
    }
    const click = (event: MouseEvent) => {
      block(event)
      const element = event.composedPath().find((node) => node instanceof win.Element)
      target = element instanceof win.Element ? element : target
      if (!target || target === overlay) return
      const parts: string[] = []
      let node: Element | null = target
      while (node) {
        if (node.id) {
          parts.unshift(`#${win.CSS.escape(node.id)}`)
          break
        }
        let part = node.localName
        const parent: Element | null = node.parentElement
        if (parent) {
          const siblings = Array.from(parent.children).filter(
            (s) => s.localName === node!.localName,
          )
          if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`
        }
        parts.unshift(part)
        node = parent
      }
      const root = target.getRootNode()
      const shadow = root instanceof win.ShadowRoot
      overlay.remove()
      const html = target.outerHTML
      const r = target.getBoundingClientRect()
      const x = Math.max(0, Math.floor(r.left))
      const y = Math.max(0, Math.floor(r.top))
      finish({
        url: doc.URL.slice(0, 8192),
        title: doc.title.slice(0, 1024),
        selector: `${shadow ? '[inside shadow root] ' : ''}${parts.join(' > ')}`.slice(0, 8192),
        html: html.slice(0, 100_000),
        truncated: html.length > 100_000,
        rect: {
          x,
          y,
          width: Math.max(0, Math.min(win.innerWidth, Math.ceil(r.right)) - x),
          height: Math.max(0, Math.min(win.innerHeight, Math.ceil(r.bottom)) - y),
        },
      })
    }
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      block(event)
      cancel()
    }
    const timer = setTimeout(cancel, 120_000)
    doc.addEventListener('pointermove', move, true)
    doc.addEventListener('pointerdown', block, true)
    doc.addEventListener('mousedown', block, true)
    doc.addEventListener('pointerup', block, true)
    doc.addEventListener('mouseup', block, true)
    doc.addEventListener('click', click, true)
    doc.addEventListener('keydown', key, true)
    doc.addEventListener('beddcode:cancel-element-picker', cancel)
    win.addEventListener('pagehide', cancel)
  })
}

export const PICK_ELEMENT_SCRIPT = `(${pickElement.toString()})(document)`
export const CANCEL_PICK_SCRIPT =
  "document.dispatchEvent(new Event('beddcode:cancel-element-picker'))"

export function elementContext(element: PickedElement): string {
  return [
    'Browser element context',
    `Page: ${element.url}`,
    `Title: ${element.title}`,
    `Selector: ${element.selector}`,
    `Visible bounds: ${JSON.stringify(element.rect)}`,
    '',
    '--- HTML ---',
    element.html,
    ...(element.truncated ? ['', '[HTML truncated at 100,000 characters]'] : []),
  ].join('\n')
}
