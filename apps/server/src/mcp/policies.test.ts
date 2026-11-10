import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GitService } from '../workspace/git.ts'
import { ProjectStore } from '../workspace/projects.ts'
import { blockedTools, describePolicy, isDisabled, withPolicies } from './policies.ts'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))

describe('blockedTools', () => {
  const tools = ['read', 'write', 'delete', 'exec']
  it('denies by name, and allows only the listed tools when allow is set', () => {
    expect(blockedTools(undefined, tools)).toEqual([])
    expect(blockedTools({ toolsDeny: ['delete', 'exec'] }, tools)).toEqual(['delete', 'exec'])
    expect(blockedTools({ toolsAllow: ['read', 'write'] }, tools)).toEqual(['delete', 'exec'])
    // Deny wins over allow.
    expect(blockedTools({ toolsAllow: ['read', 'delete'], toolsDeny: ['delete'] }, tools)).toEqual([
      'write',
      'delete',
      'exec',
    ])
  })
})

describe('policy description and annotation', () => {
  it('describes a policy in one line', () => {
    expect(describePolicy(undefined)).toBeUndefined()
    expect(describePolicy({ enabled: false })).toBe('off')
    expect(describePolicy({ toolsDeny: ['exec'] })).toBe('deny 1')
    expect(describePolicy({ toolsAllow: ['read'] })).toBe('allow 1')
  })

  it('attaches policies to servers by name', () => {
    const servers = [{ name: 'a' }, { name: 'b' }] as never[]
    const out = withPolicies(servers, { a: { enabled: false } })
    expect(out[0]).toEqual({ name: 'a', policy: { enabled: false } })
    expect(out[1]).toEqual({ name: 'b' })
  })

  it('isDisabled only when explicitly off', () => {
    expect(isDisabled(undefined)).toBe(false)
    expect(isDisabled({})).toBe(false)
    expect(isDisabled({ enabled: false })).toBe(true)
    expect(isDisabled({ enabled: true })).toBe(false)
  })
})

describe('ProjectStore MCP policies', () => {
  it('stores policies per project, resolves worktrees to their repository, and clears them', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'beddcode-proj-'))
    dirs.push(dir)
    const store = new ProjectStore(path.join(dir, 'projects.json'), new GitService())
    const repo = path.join(dir, 'repo')
    const { execFileSync } = await import('node:child_process')
    execFileSync('git', ['init', '-q', repo])
    await store.add(repo)

    expect(store.mcpPoliciesFor(repo)).toEqual({})
    await store.setMcpPolicy(repo, 'github', { enabled: false, toolsDeny: ['delete_repo'] })
    await store.setMcpPolicy(repo, 'fetch', { toolsAllow: ['read'] })
    expect(store.mcpPoliciesFor(repo)).toEqual({
      github: { enabled: false, toolsDeny: ['delete_repo'] },
      fetch: { toolsAllow: ['read'] },
    })
    // A worktree of the repo resolves to the same policies.
    const wt = path.join(repo, '.wt', 'feature')
    expect(store.projectRootFor(wt)).toBe(path.resolve(repo))
    expect(store.mcpPoliciesFor(wt)).toEqual(store.mcpPoliciesFor(repo))
    // Outside any project: none.
    expect(store.mcpPoliciesFor(dir)).toEqual({})

    await store.setMcpPolicy(repo, 'github', null)
    expect(store.mcpPoliciesFor(repo)).toEqual({ fetch: { toolsAllow: ['read'] } })
    // Removing the project drops its policies.
    store.remove(repo)
    expect(store.mcpPoliciesFor(repo)).toEqual({})
    // Setting a policy outside a project is refused.
    await expect(store.setMcpPolicy(dir, 'x', {})).rejects.toThrow('not an added project')
  })
})
