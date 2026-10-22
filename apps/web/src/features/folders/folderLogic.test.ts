import { describe, expect, it } from 'vitest'
import type { Project } from '@beddcode/contracts'
import {
  addOutcome,
  browseShortcut,
  folderBaseName,
  foldersWithoutSessions,
  modifiedLabel,
  recentFolders,
  rememberFolder,
  samePath,
  shortPath,
  visibleCrumbs,
} from './folderLogic.ts'

const project = (path: string, extra: Partial<Project> = {}): Project => ({
  path,
  name: folderBaseName(path),
  isRepo: true,
  branch: 'main',
  ...extra,
})

describe('folder logic', () => {
  it('compares paths like the host does', () => {
    expect(samePath('/a/b/', '/a/b')).toBe(true)
    expect(samePath('/a/B', '/a/b')).toBe(false)
    expect(samePath('C:\\Src\\App', 'c:\\src\\app\\')).toBe(true)
    expect(samePath('/', '/')).toBe(true)
    expect(folderBaseName('C:\\src\\app\\')).toBe('app')
  })

  it('offers folders not added yet first and greys out added ones', () => {
    const rows = recentFolders({
      history: ['/w/notes', '/w/acportal'],
      sessionPaths: ['/w/BeddCode', '/w/notes/'],
      projects: [project('/w/BeddCode')],
    })
    expect(rows.map((r) => [r.name, r.added])).toEqual([
      ['notes', false],
      ['acportal', false],
      ['BeddCode', true],
    ])
    expect(rows[2]).toMatchObject({ isRepo: true, branch: 'main' })
    expect(
      recentFolders({ history: ['/a', '/b', '/c'], sessionPaths: [], projects: [], limit: 2 }),
    ).toHaveLength(2)
  })

  it('remembers picked folders most recent first', () => {
    expect(rememberFolder(['/a', '/b'], '/b')).toEqual(['/b', '/a'])
    expect(rememberFolder(['/a', '/b'], '/c', 2)).toEqual(['/c', '/a'])
  })

  it('tells a new folder from one that was already added', () => {
    const before = [project('/w/BeddCode')]
    expect(addOutcome(before, project('/w/BeddCode'))).toBe('already')
    expect(addOutcome(before, project('/w/notes', { isRepo: false }))).toBe('added')
  })

  it('shortens paths inside the home folder', () => {
    expect(shortPath('/home/g/code/api', '/home/g')).toBe('~/code/api')
    expect(shortPath('/home/g', '/home/g/')).toBe('~')
    expect(shortPath('/home/gx/api', '/home/g')).toBe('/home/gx/api')
    expect(shortPath('C:\\Users\\G\\src', 'c:\\users\\g')).toBe('~\\src')
    expect(shortPath('/srv/x')).toBe('/srv/x')
  })

  it('starts breadcrumbs at home when inside it', () => {
    const crumbs = [
      { name: '/', path: '/' },
      { name: 'home', path: '/home' },
      { name: 'g', path: '/home/g', home: true },
      { name: 'code', path: '/home/g/code' },
    ]
    expect(visibleCrumbs(crumbs).map((c) => c.name)).toEqual(['g', 'code'])
    expect(visibleCrumbs(crumbs.slice(0, 2)).map((c) => c.name)).toEqual(['/', 'home'])
  })

  it('labels modification times compactly', () => {
    const now = new Date(2026, 9, 22, 12, 0).getTime()
    expect(modifiedLabel(now - 20_000, now)).toBe('just now')
    expect(modifiedLabel(now - 20 * 60_000, now)).toBe('20m ago')
    expect(modifiedLabel(now - 2 * 3_600_000, now)).toBe('2h ago')
    expect(modifiedLabel(new Date(2026, 9, 19, 9).getTime(), now)).toBe('Mon')
    expect(modifiedLabel(new Date(2026, 9, 3).getTime(), now)).toBe('3 Oct')
    expect(modifiedLabel(new Date(2025, 8, 28).getTime(), now)).toBe('28 Sep 2025')
  })

  it('shows the platform shortcut', () => {
    expect(browseShortcut(true)).toEqual(['⌘', 'O'])
    expect(browseShortcut(false)).toEqual(['Ctrl', 'O'])
  })

  it('keeps added folders without sessions as their own groups', () => {
    const folders = [
      { hostKey: 'local', project: project('/w/BeddCode') },
      { hostKey: 'local', project: project('/w/notes') },
      { hostKey: 'box', project: project('/w/notes') },
    ]
    const empty = foldersWithoutSessions(folders, [
      { hostKey: 'local', projectPath: '/w/BeddCode' },
    ])
    expect(empty.map((f) => `${f.hostKey}:${f.project.name}`)).toEqual(['local:notes', 'box:notes'])
  })
})
