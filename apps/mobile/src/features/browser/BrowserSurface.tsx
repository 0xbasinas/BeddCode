import { forwardRef, useImperativeHandle, useRef } from 'react'

import { colors } from '@/theme/tokens'
import { Web, type WebHandle, type WebNavigation } from '@/ui/WebViewCompat'
import { PICKER_SCRIPT, START_PICKING, STOP_PICKING } from './pickerScript'

export interface BrowserHandle {
  goBack(): void
  goForward(): void
  reload(): void
  setPicking(on: boolean): void
}

interface Props {
  url: string
  onNavigation(state: WebNavigation): void
  /** The page reported an element the user tapped while picking (the desktop's PickedElement). */
  onPicked(raw: unknown): void
}

/** One page in a WebView, with the element picker injected. */
export const BrowserSurface = forwardRef<BrowserHandle, Props>(function BrowserSurface(
  { url, onNavigation, onPicked },
  ref,
) {
  const web = useRef<WebHandle>(null)

  useImperativeHandle(ref, () => ({
    goBack: () => web.current?.goBack(),
    goForward: () => web.current?.goForward(),
    reload: () => web.current?.reload(),
    setPicking: (on) => web.current?.injectJavaScript(on ? START_PICKING : STOP_PICKING),
  }))

  return (
    <Web
      ref={web}
      source={{ uri: url }}
      style={{ flex: 1, backgroundColor: colors.panel }}
      injectedJavaScript={PICKER_SCRIPT}
      onNavigationStateChange={(state: WebNavigation) => onNavigation(state)}
      onMessage={(event: { nativeEvent: { data: string } }) => {
        try {
          const message = JSON.parse(event.nativeEvent.data) as { type?: string; element?: unknown }
          if (message.type === 'picked') onPicked(message.element)
        } catch {
          // Not ours.
        }
      }}
      allowsInlineMediaPlayback
      setSupportMultipleWindows={false}
      mixedContentMode="always"
    />
  )
})
