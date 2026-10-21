import { describe, expect, it } from 'vitest'
import { normalizeUrl, tabLabel } from './url.ts'

describe('normalizeUrl', () => {
  it('keeps full http and https addresses', () => {
    expect(normalizeUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1')
    expect(normalizeUrl('http://localhost:3000/admin')).toBe('http://localhost:3000/admin')
    expect(normalizeUrl('  https://example.com  ')).toBe('https://example.com')
  })

  it('uses http for local and private hosts, https for everything else', () => {
    expect(normalizeUrl('localhost:3000/admin/limits')).toBe('http://localhost:3000/admin/limits')
    expect(normalizeUrl('127.0.0.1:5173')).toBe('http://127.0.0.1:5173')
    expect(normalizeUrl('192.168.1.20:8080')).toBe('http://192.168.1.20:8080')
    expect(normalizeUrl('100.101.102.103:3773')).toBe('http://100.101.102.103:3773')
    expect(normalizeUrl('my-box.tail1234.ts.net:3000')).toBe('http://my-box.tail1234.ts.net:3000')
    expect(normalizeUrl('[::1]:3000')).toBe('http://[::1]:3000')
    expect(normalizeUrl('example.com')).toBe('https://example.com')
    expect(normalizeUrl('docs.example.com/guide')).toBe('https://docs.example.com/guide')
  })

  it('does not treat a public address in the 172 or 100 ranges as private', () => {
    expect(normalizeUrl('172.32.0.1')).toBe('https://172.32.0.1')
    expect(normalizeUrl('100.63.0.1')).toBe('https://100.63.0.1')
  })

  it('turns other text into a search', () => {
    expect(normalizeUrl('how to rebase')).toBe('https://duckduckgo.com/?q=how%20to%20rebase')
    expect(normalizeUrl('react')).toBe('https://duckduckgo.com/?q=react')
  })

  it('refuses other schemes and empty input', () => {
    expect(normalizeUrl('javascript:alert(1)')).toBeNull()
    expect(normalizeUrl('file:///C:/secret.txt')).toBeNull()
    expect(normalizeUrl('data:text/html,<h1>x</h1>')).toBeNull()
    expect(normalizeUrl('ftp://example.com')).toBeNull()
    expect(normalizeUrl('   ')).toBeNull()
  })
})

describe('tabLabel', () => {
  it('shows host and path', () => {
    expect(tabLabel('http://localhost:3000/admin/limits')).toBe('localhost:3000/admin/limits')
    expect(tabLabel('https://example.com/')).toBe('example.com')
    expect(tabLabel('not a url')).toBe('not a url')
  })
})
