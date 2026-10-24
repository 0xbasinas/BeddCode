import type { PullRequestDetail } from '@beddcode/contracts'
import { describe, expect, it } from 'vitest'
import {
  checksSummary,
  commentText,
  checksLabel,
  githubProblem,
  mergeBlocker,
  mergeWarning,
  prDraftFromCommits,
  prStateKind,
  reviewLabel,
  titleFromBranch,
} from './pullRequests.ts'

const detail = (over: Partial<PullRequestDetail> = {}): PullRequestDetail => ({
  number: 1,
  title: 'T',
  url: 'u',
  state: 'OPEN',
  isDraft: false,
  body: '',
  headBranch: 'feat',
  baseBranch: 'main',
  checks: [],
  files: [],
  author: 'octo',
  timeline: [],
  mergeable: 'MERGEABLE',
  mergeState: 'CLEAN',
  ...over,
})

describe('pull request labels', () => {
  it('names states and reviews', () => {
    expect(prStateKind({ state: 'OPEN', isDraft: true })).toBe('draft')
    expect(prStateKind({ state: 'MERGED', isDraft: false })).toBe('merged')
    expect(reviewLabel('CHANGES_REQUESTED')).toBe('Changes requested')
    expect(reviewLabel('')).toBeUndefined()
  })
  it('sums up checks', () => {
    expect(checksLabel({})).toBe('No checks')
    expect(
      checksLabel({
        checks: 'failure',
        checkCounts: { total: 3, passed: 2, failed: 1, pending: 0 },
      }),
    ).toBe('1 of 3 checks failing')
    expect(
      checksLabel({
        checks: 'success',
        checkCounts: { total: 2, passed: 2, failed: 0, pending: 0 },
      }),
    ).toBe('2 of 2 checks passed')
  })
})

describe('mergeBlocker / mergeWarning', () => {
  it('lets a clean pull request merge', () => {
    expect(mergeBlocker(detail())).toBeUndefined()
    expect(mergeWarning(detail())).toBeUndefined()
  })
  it('explains what stops a merge', () => {
    expect(mergeBlocker(detail({ isDraft: true }))).toMatch(/draft/)
    expect(mergeBlocker(detail({ mergeable: 'CONFLICTING' }))).toMatch(/conflicts/)
    expect(mergeBlocker(detail({ mergeState: 'BLOCKED' }))).toMatch(/required/)
    expect(mergeBlocker(detail({ state: 'MERGED' }))).toMatch(/already merged/)
  })
  it('warns about failing or running checks without blocking', () => {
    expect(
      mergeWarning(detail({ mergeState: 'UNSTABLE', checks: [{ name: 'ci', state: 'failure' }] })),
    ).toBe('Some checks failed')
    expect(mergeWarning(detail({ checks: [{ name: 'ci', state: 'pending' }] }))).toMatch(/running/)
  })
})

describe('prDraftFromCommits', () => {
  it('borrows a lone commit subject', () => {
    expect(prDraftFromCommits([{ subject: 'Fix refill' }], 'fix/x')).toEqual({
      title: 'Fix refill',
      body: '',
    })
  })
  it('lists several commits oldest first under a title from the branch', () => {
    expect(
      prDraftFromCommits([{ subject: 'Second' }, { subject: 'First' }], 'feat/pr-pane'),
    ).toEqual({ title: 'Pr pane', body: '- First\n- Second' })
    expect(titleFromBranch('beddcode/a1b2c3')).toBe('A1b2c3')
  })
})

describe('githubProblem', () => {
  it('points at gh auth login when signed out or missing', () => {
    expect(githubProblem({ state: 'signed-out' })?.command).toBe('gh auth login')
    expect(githubProblem({ state: 'not-installed' })?.link).toBe('https://cli.github.com')
    expect(githubProblem({ state: 'no-repo' })?.title).toMatch(/not on GitHub/)
    expect(
      githubProblem({
        state: 'ready',
        login: 'o',
        repo: 'o/r',
        url: 'u',
        mergeMethods: [],
        deleteBranchOnMerge: false,
      }),
    ).toBeUndefined()
  })
})

describe('checksSummary', () => {
  it('rolls full checks up the way list rows carry them', () => {
    expect(checksSummary([])).toEqual({})
    expect(
      checksSummary([
        { name: 'a', state: 'success' },
        { name: 'b', state: 'pending' },
      ]),
    ).toEqual({
      checks: 'pending',
      checkCounts: { total: 2, passed: 1, failed: 0, pending: 1 },
    })
    expect(checksSummary([{ name: 'a', state: 'failure' }]).checks).toBe('failure')
  })
})

describe('commentText', () => {
  it('drops raw HTML and hidden markers but keeps the words and Markdown', () => {
    expect(
      commentText(
        '<!-- bot:marker -->\n**Review** the <a href="x">changes</a>\n<table><tr><td>pkg</td></tr></table>',
      ),
    ).toBe('**Review** the changes \n pkg')
    expect(commentText('keep a < b as is')).toBe('keep a < b as is')
  })
})
