import { describe, expect, it } from 'vitest'
import { fileIconId, folderIconIds } from './FileIcon.tsx'

describe('file icons', () => {
  it('picks a file by its name first, then its longest known extension', () => {
    expect(fileIconId('package.json')).not.toBe(fileIconId('other.json'))
    expect(fileIconId('src/app/main.ts')).toBe(fileIconId('x.ts'))
    expect(fileIconId('token.test.ts')).not.toBe(fileIconId('token.ts'))
    expect(fileIconId('C:\proj\README.md')).toBe(fileIconId('README.md'))
    expect(fileIconId('Weird.XYZ')).toBe('file')
    expect(fileIconId('.gitignore')).not.toBe('file')
  })

  it('picks a folder by its name, closed and open', () => {
    const [closed, open] = folderIconIds('src')
    expect(closed).not.toBe('folder')
    expect(open).not.toBe(closed)
    expect(folderIconIds('Whatever')).toEqual(['folder', 'folder-open'])
  })
})
