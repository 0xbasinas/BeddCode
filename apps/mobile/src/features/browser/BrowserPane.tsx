import {
  elementContext,
  normalizeUrl,
  reachableUrl,
  tabLabel,
  type PickedElement,
} from '@beddcode/client-runtime'
import {
  ArrowClockwise,
  ArrowLeft,
  ArrowRight,
  CursorClick,
  Globe,
  Plus,
  X,
} from 'phosphor-react-native'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native'

import { textToBase64 } from '@/host/attachments'
import { hostHttpBase, hostRequest, prompt } from '@/host/store'
import { useWorkspace } from '@/host/workspace'
import { colors, fonts, radius } from '@/theme/tokens'
import { Button } from '@/ui/Button'
import { Icon } from '@/ui/Icon'
import type { WebNavigation } from '@/ui/WebViewCompat'
import { Faint, Muted, Text } from '@/ui/Text'
import { BrowserSurface, type BrowserHandle } from './BrowserSurface'

interface Tab {
  id: number
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
}

let nextTab = 1

/** The desktop's Browser pane: pages of your dev server, and tap-to-pick elements to show the agent. */
export function BrowserPane({ sessionId, onSent }: { sessionId: string; onSent(): void }) {
  const { session, hostKey } = useWorkspace(sessionId)
  const [tabs, setTabs] = useState<Tab[]>([])
  const [active, setActive] = useState<number>()
  const [address, setAddress] = useState('')
  const [picking, setPicking] = useState(false)
  const [picked, setPicked] = useState<PickedElement | null>(null)
  const [comment, setComment] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string>()
  const surfaces = useRef(new Map<number, BrowserHandle>())

  const current = tabs.find((t) => t.id === active)
  const base = hostKey ? hostHttpBase(hostKey) : undefined

  useEffect(() => {
    setAddress(current?.url ?? '')
  }, [current?.id, current?.url])

  const open = useCallback(
    (input: string, newTab = false) => {
      const url = normalizeUrl(input)
      if (!url) {
        setError('Enter a web address, such as localhost:3000.')
        return
      }
      setError(undefined)
      const target = reachableUrl(url, base)
      setPicking(false)
      setPicked(null)
      if (current && !newTab) {
        setTabs((ts) => ts.map((t) => (t.id === current.id ? { ...t, url: target, title: '' } : t)))
        return
      }
      const tab: Tab = {
        id: nextTab++,
        url: target,
        title: '',
        loading: true,
        canGoBack: false,
        canGoForward: false,
      }
      setTabs((ts) => [...ts, tab])
      setActive(tab.id)
    },
    [base, current],
  )

  const closeTab = (id: number) => {
    setTabs((ts) => {
      const next = ts.filter((t) => t.id !== id)
      if (active === id) setActive(next.at(-1)?.id)
      return next
    })
    surfaces.current.delete(id)
    setPicking(false)
    setPicked(null)
  }

  const togglePicking = () => {
    const on = !picking
    setPicking(on)
    setPicked(null)
    if (current) surfaces.current.get(current.id)?.setPicking(on)
  }

  const send = async () => {
    if (!picked || !hostKey) return
    setSending(true)
    setError(undefined)
    try {
      const file = await hostRequest(hostKey, 'attachments.upload', {
        name: 'browser-element.txt',
        dataBase64: textToBase64(elementContext(picked)),
      })
      await prompt(sessionId, comment.trim() || `Look at this element: ${picked.selector}`, [
        file.id,
      ])
      setPicked(null)
      setComment('')
      setPicking(false)
      if (current) surfaces.current.get(current.id)?.setPicking(false)
      onSent()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSending(false)
    }
  }

  const navigation = (id: number) => (state: WebNavigation) =>
    setTabs((ts) =>
      ts.map((t) =>
        t.id === id
          ? {
              ...t,
              url: state.url || t.url,
              title: state.title || t.title,
              loading: state.loading,
              canGoBack: state.canGoBack,
              canGoForward: state.canGoForward,
            }
          : t,
      ),
    )

  if (!session || !hostKey) {
    return (
      <View style={styles.center}>
        <Muted size={13.5}>Loading…</Muted>
      </View>
    )
  }

  const subtitle = current ? tabLabel(current.url) : 'Open a page'

  return (
    <View style={{ flex: 1 }}>
      <View style={styles.head}>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 10, flexShrink: 1 }}>
          <Text size={15} weight="medium">
            Browser
          </Text>
          <Faint size={12.5} numberOfLines={1} style={{ flexShrink: 1 }}>
            {subtitle}
          </Faint>
        </View>
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ flexGrow: 0 }}
        contentContainerStyle={styles.tabs}
      >
        {tabs.map((t) => (
          <Pressable
            key={t.id}
            style={[styles.tab, t.id === active && { backgroundColor: colors.active }]}
            onPress={() => {
              setActive(t.id)
              setPicking(false)
              setPicked(null)
            }}
          >
            <Text
              size={12.5}
              color={t.id === active ? colors.text : colors.muted}
              numberOfLines={1}
              style={{ maxWidth: 130 }}
            >
              {t.title || tabLabel(t.url)}
            </Text>
            <Pressable hitSlop={8} onPress={() => closeTab(t.id)} accessibilityLabel="Close tab">
              <Icon icon={X} size={11} />
            </Pressable>
          </Pressable>
        ))}
        <Pressable
          style={styles.tab}
          onPress={() => setActive(undefined)}
          accessibilityLabel="New tab"
        >
          <Icon icon={Plus} size={15} />
        </Pressable>
      </ScrollView>

      <View style={styles.bar}>
        <Pressable
          hitSlop={8}
          disabled={!current?.canGoBack}
          onPress={() => current && surfaces.current.get(current.id)?.goBack()}
          style={!current?.canGoBack && { opacity: 0.35 }}
        >
          <Icon icon={ArrowLeft} size={18} />
        </Pressable>
        <Pressable
          hitSlop={8}
          disabled={!current?.canGoForward}
          onPress={() => current && surfaces.current.get(current.id)?.goForward()}
          style={!current?.canGoForward && { opacity: 0.35 }}
        >
          <Icon icon={ArrowRight} size={18} />
        </Pressable>
        <Pressable
          hitSlop={8}
          disabled={!current}
          onPress={() => current && surfaces.current.get(current.id)?.reload()}
          style={!current && { opacity: 0.35 }}
        >
          <Icon icon={ArrowClockwise} size={18} />
        </Pressable>
        <View style={styles.urlBox}>
          <TextInput
            value={address}
            onChangeText={setAddress}
            onSubmitEditing={() => open(address)}
            placeholder="localhost:3000"
            placeholderTextColor={colors.faint}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            returnKeyType="go"
            style={styles.urlInput}
          />
          {current && !current.loading ? (
            <Text size={10.5} color={colors.success}>
              ● live
            </Text>
          ) : null}
        </View>
        <Pressable
          style={[styles.pick, picking && { backgroundColor: '#1e3a6a' }]}
          disabled={!current}
          onPress={togglePicking}
        >
          <Icon icon={CursorClick} size={15} color={colors.info} />
          <Text size={12.5} color={colors.info}>
            Pick
          </Text>
        </Pressable>
      </View>

      {picking ? (
        <View style={styles.hint}>
          <Text size={11.5} color={colors.info}>
            Tap any element to leave a comment for the agent
          </Text>
        </View>
      ) : null}
      {error ? (
        <Text size={12} color={colors.danger} style={{ paddingHorizontal: 16, paddingVertical: 4 }}>
          {error}
        </Text>
      ) : null}

      <View style={styles.page}>
        {tabs.length === 0 || active === undefined ? (
          <View style={styles.center}>
            <Icon icon={Globe} size={30} />
            <Text size={16} weight="semibold" style={{ marginTop: 10 }}>
              Open a page
            </Text>
            <Muted size={13} style={{ textAlign: 'center', marginBottom: 14 }}>
              Type an address above. "localhost" means the computer running this session.
            </Muted>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Button label="localhost:3000" onPress={() => open('localhost:3000', true)} />
              <Button label="localhost:5173" onPress={() => open('localhost:5173', true)} />
            </View>
          </View>
        ) : null}
        {tabs.map((t) => (
          <View
            key={t.id}
            style={[StyleSheet.absoluteFill, t.id !== active && { display: 'none' }]}
          >
            <BrowserSurface
              ref={(handle) => {
                if (handle) surfaces.current.set(t.id, handle)
              }}
              url={t.url}
              onNavigation={navigation(t.id)}
              onPicked={(raw) => setPicked(raw as PickedElement)}
            />
          </View>
        ))}
      </View>

      {picked ? (
        <View style={styles.popover}>
          <View style={styles.popHead}>
            <Text
              size={11.5}
              mono
              color={colors.textSecondary}
              numberOfLines={1}
              style={{ flex: 1 }}
            >
              {picked.selector.split(' > ').at(-1)}
            </Text>
            <Pressable hitSlop={8} onPress={() => setPicked(null)}>
              <Icon icon={X} size={14} />
            </Pressable>
          </View>
          <TextInput
            value={comment}
            onChangeText={setComment}
            placeholder="What should the agent change here?"
            placeholderTextColor={colors.faint}
            multiline
            autoFocus
            style={styles.comment}
          />
          <View style={{ flexDirection: 'row', justifyContent: 'flex-end' }}>
            <Button
              label={sending ? 'Sending…' : 'Send to agent'}
              kind="primary"
              disabled={sending}
              onPress={() => void send()}
              style={{ minHeight: 38 }}
            />
          </View>
        </View>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 6,
  },
  tabs: { gap: 6, paddingHorizontal: 12, paddingBottom: 6 },
  tab: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radius.control,
  },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 12,
    paddingBottom: 8,
  },
  urlBox: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.control,
    paddingHorizontal: 10,
  },
  urlInput: {
    flex: 1,
    color: colors.textSecondary,
    fontFamily: fonts.regular,
    fontSize: 12.5,
    paddingVertical: 8,
  },
  pick: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderWidth: 1,
    borderColor: '#2f4f8a',
    backgroundColor: '#16223a',
    borderRadius: radius.control,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  hint: { backgroundColor: '#12203a', paddingHorizontal: 16, paddingVertical: 6 },
  page: {
    flex: 1,
    margin: 8,
    marginBottom: 4,
    borderRadius: radius.panel,
    overflow: 'hidden',
    backgroundColor: colors.card,
  },
  popover: {
    position: 'absolute',
    left: 12,
    right: 12,
    bottom: 16,
    backgroundColor: colors.hover,
    borderRadius: radius.panel + 2,
    padding: 12,
    gap: 10,
    borderWidth: 1,
    borderColor: colors.border,
  },
  popHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  comment: {
    color: colors.text,
    fontFamily: fonts.regular,
    fontSize: 13.5,
    minHeight: 56,
    maxHeight: 120,
    textAlignVertical: 'top',
  },
})
