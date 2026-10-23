import { describe, expect, it } from 'vitest'
import { agoLabel, effortLabel, folderName, formatBytes, timeAgo } from './format.ts'

describe('format', () => {
  it('labels effort levels the way the designs do', () => {
    expect(effortLabel('xhigh')).toBe('Extra high')
    expect(effortLabel('medium')).toBe('Medium')
    expect(effortLabel('custom')).toBe('custom')
  })

  it('shows compact relative times', () => {
    const now = 1_000_000_000
    expect(timeAgo(now - 10_000, now)).toBe('now')
    expect(timeAgo(now - 3 * 60_000, now)).toBe('3m')
    expect(timeAgo(now - 2 * 3_600_000, now)).toBe('2h')
    expect(timeAgo(now - 3 * 86_400_000, now)).toBe('3d')
  })

  it('words relative times for commits', () => {
    const now = 1_000_000_000
    expect(agoLabel(now - 5_000, now)).toBe('just now')
    expect(agoLabel(now - 12 * 60_000, now)).toBe('12m ago')
  })

  it('takes the last folder of POSIX and Windows paths', () => {
    expect(folderName('/home/me/api-gateway')).toBe('api-gateway')
    expect(folderName('C:\\src\\ml-pipeline\\')).toBe('ml-pipeline')
  })

  it('formats sizes', () => {
    expect(formatBytes(500)).toBe('500 B')
    expect(formatBytes(2048)).toBe('2 KB')
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB')
  })
})
