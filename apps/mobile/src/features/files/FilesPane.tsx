import type { FileEntry } from '@beddcode/contracts'
import {
  ArrowsInLineVertical,
  CaretDown,
  CaretRight,
  File,
  FileCode,
  FileCss,
  FileHtml,
  FileJs,
  FileJsx,
  FileMd,
  FilePy,
  FileText,
  FileTs,
  FileTsx,
  FolderSimple,
  Image as ImageGlyph,
  MagnifyingGlass,
} from 'phosphor-react-native'
import type { Icon as PhosphorIcon } from 'phosphor-react-native'
import { useCallback, useEffect, useRef, useState } from 'react'
import { FlatList, Pressable, StyleSheet, TextInput, View } from 'react-native'

import { hostRequest, onHostFrame, sendHostFrame, useRuntime } from '@/host/store'
import { useWorkspace } from '@/host/workspace'
import { colors, fonts, radius } from '@/theme/tokens'
import { Icon } from '@/ui/Icon'
import { Faint, Muted, Text } from '@/ui/Text'
import { FileViewer } from './FileViewer'

const FILE_ICONS: Record<string, PhosphorIcon> = {
  ts: FileTs,
  tsx: FileTsx,
  js: FileJs,
  mjs: FileJs,
  cjs: FileJs,
  jsx: FileJsx,
  css: FileCss,
  html: FileHtml,
  py: FilePy,
  md: FileMd,
  txt: FileText,
  json: FileCode,
  yml: FileCode,
  yaml: FileCode,
  toml: FileCode,
  png: ImageGlyph,
  jpg: ImageGlyph,
  jpeg: ImageGlyph,
  gif: ImageGlyph,
  webp: ImageGlyph,
  svg: ImageGlyph,
}

const iconFor = (name: string) => FILE_ICONS[name.split('.').pop()?.toLowerCase() ?? ''] ?? File

interface Row {
  key: string
  path: string
  name: string
  depth: number
  type: 'file' | 'dir'
  ignored?: boolean
  open?: boolean
}

/** The project's files: a tree to browse, search to jump, and a viewer you can attach from. */
export function FilesPane({ sessionId, onAttached }: { sessionId: string; onAttached(): void }) {
  const { hostKey, cwd, session } = useWorkspace(sessionId)
  const runtime = useRuntime(hostKey)
  const [dirs, setDirs] = useState<Record<string, FileEntry[]>>({})
  const [open, setOpen] = useState<Set<string>>(new Set(['']))
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<string[] | null>(null)
  const [error, setError] = useState<string>()
  const [file, setFile] = useState<string>()
  const openRef = useRef(open)
  openRef.current = open

  const loadDir = useCallback(
    async (dir: string) => {
      if (!hostKey || !cwd) return
      try {
        const { entries } = await hostRequest(hostKey, 'files.list', { cwd, dir: dir || undefined })
        setDirs((d) => ({ ...d, [dir]: entries }))
        setError(undefined)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    },
    [hostKey, cwd],
  )

  // Reload what is open whenever the connection is (re)established.
  useEffect(() => {
    if (runtime.connection !== 'connected') return
    for (const dir of openRef.current) void loadDir(dir)
  }, [runtime.epoch, runtime.connection, loadDir])

  // The agent edits files while you look: refresh the folders that changed.
  useEffect(() => {
    if (!hostKey || !cwd) return
    sendHostFrame(hostKey, { t: 'fs.watch', cwd })
    const off = onHostFrame(hostKey, (frame) => {
      if (frame.t !== 'fs.changed' || frame.cwd !== cwd) return
      const touched = new Set(frame.paths.map((p) => p.split('/').slice(0, -1).join('/')))
      for (const dir of openRef.current) if (touched.has(dir)) void loadDir(dir)
    })
    return () => {
      off()
      sendHostFrame(hostKey, { t: 'fs.unwatch', cwd })
    }
  }, [hostKey, cwd, runtime.epoch, loadDir])

  useEffect(() => {
    if (!hostKey || !cwd || query.trim().length < 2) {
      setResults(null)
      return
    }
    const timer = setTimeout(() => {
      hostRequest(hostKey, 'files.search', { cwd, query: query.trim() })
        .then((r) => setResults(r.paths))
        .catch(() => setResults([]))
    }, 200)
    return () => clearTimeout(timer)
  }, [query, hostKey, cwd])

  if (!session || !hostKey || !cwd) {
    return (
      <View style={styles.center}>
        <Muted size={13.5}>Loading…</Muted>
      </View>
    )
  }

  if (file) {
    return (
      <FileViewer
        hostKey={hostKey}
        sessionId={sessionId}
        cwd={cwd}
        path={file}
        onClose={() => setFile(undefined)}
        onAttached={() => {
          setFile(undefined)
          onAttached()
        }}
      />
    )
  }

  const toggle = (dir: string) => {
    setOpen((o) => {
      const next = new Set(o)
      if (next.has(dir)) next.delete(dir)
      else {
        next.add(dir)
        if (!dirs[dir]) void loadDir(dir)
      }
      return next
    })
  }

  const rows: Row[] = []
  const walk = (dir: string, depth: number) => {
    for (const e of dirs[dir] ?? []) {
      const path = dir ? `${dir}/${e.name}` : e.name
      const isOpen = e.type === 'dir' && open.has(path)
      rows.push({
        key: path,
        path,
        name: e.name,
        depth,
        type: e.type,
        ignored: e.ignored,
        open: isOpen,
      })
      if (isOpen) walk(path, depth + 1)
    }
  }
  walk('', 0)

  const searching = results !== null
  const projectName = cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? cwd

  return (
    <View style={{ flex: 1 }}>
      <View style={styles.head}>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 10 }}>
          <Text size={15} weight="medium">
            Files
          </Text>
          <Faint size={13}>{projectName}</Faint>
        </View>
        <Pressable
          hitSlop={10}
          onPress={() => setOpen(new Set(['']))}
          accessibilityLabel="Collapse all"
        >
          <Icon icon={ArrowsInLineVertical} size={19} />
        </Pressable>
      </View>
      <View style={styles.search}>
        <Icon icon={MagnifyingGlass} size={16} color={colors.faint} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search files"
          placeholderTextColor={colors.faint}
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.searchInput}
        />
      </View>
      {error ? (
        <Text size={12.5} color={colors.danger} style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
          {error}
        </Text>
      ) : null}
      {searching ? (
        <FlatList
          data={results}
          keyExtractor={(p) => p}
          keyboardShouldPersistTaps="handled"
          ListEmptyComponent={
            <Muted size={13} style={{ padding: 16 }}>
              No files match.
            </Muted>
          }
          renderItem={({ item }) => (
            <Pressable style={styles.row} onPress={() => setFile(item)}>
              <Icon icon={iconFor(item)} size={18} />
              <View style={{ flex: 1 }}>
                <Text size={14} numberOfLines={1}>
                  {item.split('/').pop()}
                </Text>
                <Faint size={11.5} numberOfLines={1}>
                  {item}
                </Faint>
              </View>
            </Pressable>
          )}
        />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => r.key}
          contentContainerStyle={{ paddingHorizontal: 8, paddingBottom: 12 }}
          renderItem={({ item }) => (
            <Pressable
              style={({ pressed }) => [
                styles.row,
                { paddingLeft: 8 + item.depth * 16 },
                pressed && { backgroundColor: colors.hover },
              ]}
              onPress={() => (item.type === 'dir' ? toggle(item.path) : setFile(item.path))}
            >
              {item.type === 'dir' ? (
                <>
                  <Icon icon={item.open ? CaretDown : CaretRight} size={12} color={colors.faint} />
                  <Icon
                    icon={FolderSimple}
                    size={18}
                    color={item.ignored ? colors.faint : colors.muted}
                  />
                </>
              ) : (
                <>
                  <View style={{ width: 12 }} />
                  <Icon icon={iconFor(item.name)} size={18} />
                </>
              )}
              <Text
                size={14}
                color={item.ignored ? colors.faint : colors.text}
                numberOfLines={1}
                style={{ flex: 1 }}
              >
                {item.name}
              </Text>
            </Pressable>
          )}
        />
      )}
      <View style={styles.footer}>
        <Faint size={11.5}>Tap a file to read it, then pick lines to attach</Faint>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 8,
  },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.control,
    paddingHorizontal: 11,
  },
  searchInput: {
    flex: 1,
    color: colors.text,
    fontFamily: fonts.regular,
    fontSize: 13.5,
    paddingVertical: 9,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 8,
    paddingVertical: 9,
    borderRadius: radius.control,
    minHeight: 40,
  },
  footer: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle,
  },
})
