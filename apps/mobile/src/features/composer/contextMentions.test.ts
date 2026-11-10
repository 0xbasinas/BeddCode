import { describe, expect, it } from 'vitest'
import type { CiReport, GitStatus, PullRequest } from '@beddcode/contracts'
import {
  debugThisPrompt,
  formatCiMention,
  formatDiffMention,
  formatPrMention,
  formatTermMention,
  matchingContextMentions,
} from './contextMentions'

describe('matchingContextMentions', () => {
  it('offers @diff @ci @pr @term as the query grows, and hides them once a path starts', () => {
    expect(matchingContextMentions('').map((m) => m.id)).toEqual(['diff', 'ci', 'pr', 'term'])
    expect(matchingContextMentions('c').map((m) => m.id)).toEqual(['ci'])
    expect(matchingContextMentions('src/')).toEqual([])
  })
})

describe('mention formatters', () => {
  it('summarizes a dirty tree, CI, a pull request, a failed terminal, and a debug prompt', () => {
    const status: GitStatus = {
      branch: 'feat',
      ahead: 1,
      behind: 0,
      files: [{ path: 'a.ts', status: 'M', staged: false, added: 2, removed: 1 }],
    }
    expect(formatDiffMention(status)).toContain('modified a.ts')
    const ci: CiReport = {
      pr: null,
      branch: 'feat',
      runs: [
        {
          id: 1,
          workflow: 'test',
          title: 'Test',
          status: 'completed',
          conclusion: 'failure',
          url: 'https://example.com',
        },
      ],
      failures: [{ checks: ['lint'] }],
    }
    expect(formatCiMention(ci)).toContain('lint')
    const pr: PullRequest = {
      number: 12,
      title: 'Add mentions',
      url: 'https://example.com/12',
      state: 'OPEN',
      isDraft: false,
      body: '',
      headBranch: 'feat',
      baseBranch: 'main',
      checks: [{ name: 'test', state: 'failure' }],
      files: [],
    }
    expect(formatPrMention(pr)).toContain('#12')
    expect(formatPrMention(pr)).toContain('1 checks failing')
    expect(
      formatTermMention({
        id: 't',
        cwd: '/repo',
        shell: 'bash',
        title: 'build',
        exited: 1,
        text: 'error: boom',
      }),
    ).toContain('failed (exit 1)')
    expect(debugThisPrompt('error', 'boom')).toContain('boom')
  })
})
