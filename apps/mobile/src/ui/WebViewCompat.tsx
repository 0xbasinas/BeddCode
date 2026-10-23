import type { ComponentType, Ref } from 'react'
import { WebView } from 'react-native-webview'

/** What the app uses of a WebView instance. */
export interface WebHandle {
  postMessage(message: string): void
  injectJavaScript(script: string): void
  goBack(): void
  goForward(): void
  reload(): void
}

export interface WebNavigation {
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
}

/**
 * react-native-webview's own types do not match React 19's component types yet, so it is cast to
 * the props this app passes.
 */
export const Web = WebView as unknown as ComponentType<{
  ref?: Ref<WebHandle>
  [prop: string]: unknown
}>
