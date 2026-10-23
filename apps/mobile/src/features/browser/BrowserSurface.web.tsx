import { createElement, forwardRef, useImperativeHandle, useRef } from 'react'

import type { WebNavigation } from '@/ui/WebViewCompat'
import type { BrowserHandle } from './BrowserSurface'

interface Props {
  url: string
  onNavigation(state: WebNavigation): void
  onPicked(raw: unknown): void
}

/** The browser build shows the page in an iframe. Picking needs the app's WebView, so it does nothing here. */
export const BrowserSurface = forwardRef<BrowserHandle, Props>(function BrowserSurface(
  { url },
  ref,
) {
  const frame = useRef<HTMLIFrameElement | null>(null)
  useImperativeHandle(ref, () => ({
    goBack: () => frame.current?.contentWindow?.history.back(),
    goForward: () => frame.current?.contentWindow?.history.forward(),
    reload: () => {
      if (frame.current) frame.current.src = url
    },
    setPicking: () => {},
  }))
  return createElement('iframe', {
    ref: frame,
    src: url,
    style: { flex: 1, border: 'none', width: '100%', height: '100%', backgroundColor: '#fff' },
  })
})
