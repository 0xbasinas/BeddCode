import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { parseCommand } from './commands.ts'
import { appJwt, pemToPkcs8 } from './githubAuth.ts'
import { allowedSender, fromFork, parseList, withinLimit } from './policy.ts'
import { sign, verifyWebhook } from './signature.ts'
import { triage } from './webhook.ts'

describe('verifyWebhook', () => {
  it('accepts a body signed with the secret and nothing else', async () => {
    const body = '{"a":1}'
    const header = await sign('s3cret', body)
    expect(await verifyWebhook('s3cret', body, header)).toBe(true)
    expect(await verifyWebhook('s3cret', body + ' ', header)).toBe(false)
    expect(await verifyWebhook('other', body, header)).toBe(false)
    expect(await verifyWebhook('s3cret', body, null)).toBe(false)
    expect(await verifyWebhook(undefined, body, header)).toBe(false)
  })
})

describe('parseCommand', () => {
  const slug = 'beddcode'
  it('reads each command', () => {
    expect(parseCommand('@beddcode fix this', slug)?.verb).toBe('fix')
    expect(parseCommand('@beddcode review', slug)?.verb).toBe('review')
    expect(parseCommand('@beddcode fix CI', slug)?.verb).toBe('fix-ci')
    expect(parseCommand('@beddcode explain', slug)?.verb).toBe('explain')
    expect(parseCommand('@beddcode rebase on main', slug)).toMatchObject({
      verb: 'rebase',
      extra: 'on main',
    })
    expect(parseCommand('@beddcode stop', slug)?.verb).toBe('stop')
  })
  it('reads agent, model and effort, and keeps the rest as instructions', () => {
    expect(
      parseCommand('@beddcode codex model=gpt-5 effort=high fix this, mind the tests', slug),
    ).toEqual({
      verb: 'fix',
      agent: 'codex',
      model: 'gpt-5',
      effort: 'high',
      extra: 'mind the tests',
    })
    expect(parseCommand('@beddcode agent=claude fix', slug)).toMatchObject({ agent: 'claude' })
  })
  it('ignores talk that is not a command', () => {
    expect(parseCommand('thanks @beddcode', slug)).toBeUndefined()
    expect(parseCommand('@beddcode', slug)).toBeUndefined()
    expect(parseCommand('please fix this', slug)).toBeUndefined()
    expect(parseCommand('email me@beddcode.com fix this', slug)).toBeUndefined()
    expect(parseCommand('@beddcodex fix this', slug)).toBeUndefined()
  })
  it('understands plain words, with agent, model and effort picked out', () => {
    expect(
      parseCommand('@beddcode go ahead and tackle this with claude on sonnet 5.5 on low', slug),
    ).toMatchObject({
      verb: 'ask',
      agent: 'claude',
      model: 'sonnet',
      effort: 'low',
      extra: expect.stringContaining('tackle this'),
    })
    expect(
      parseCommand('@beddcode could you review this using codex, high effort?', slug),
    ).toMatchObject({ verb: 'ask', agent: 'codex', effort: 'high' })
    expect(parseCommand('@beddcode the CI is failing, please sort it', slug)?.verb).toBe('ask')
    expect(parseCommand('@beddcode what do you think?', slug)?.verb).toBe('ask')
  })
  it('ignores quotes and code blocks', () => {
    expect(parseCommand('> @beddcode fix this\nlooks good', slug)).toBeUndefined()
    expect(parseCommand('```\n@beddcode fix this\n```', slug)).toBeUndefined()
    expect(parseCommand('~~~text\n@beddcode fix this\n~~~', slug)).toBeUndefined()
    expect(parseCommand('```text\n@beddcode fix this', slug)).toBeUndefined()
    expect(parseCommand('~~~\nexample\n~~~\n@beddcode review', slug)?.verb).toBe('review')
  })
})

describe('policy', () => {
  const allowed = parseList('0xBasinas, friend')
  it('allows only listed humans', () => {
    expect(allowedSender({ login: '0xbasinas', type: 'User' }, allowed)).toBe(true)
    expect(allowedSender({ login: 'Friend' }, allowed)).toBe(true)
    expect(allowedSender({ login: 'stranger', type: 'User' }, allowed)).toBe(false)
    expect(allowedSender({ login: '0xbasinas[bot]', type: 'Bot' }, allowed)).toBe(false)
    expect(allowedSender(undefined, allowed)).toBe(false)
    expect(allowedSender({ login: 'x' }, [])).toBe(false)
  })
  it('treats a missing or different head repo as a fork', () => {
    const base = { repo: { full_name: 'a/b' } }
    expect(fromFork({ head: { repo: { full_name: 'A/B' } }, base })).toBe(false)
    expect(fromFork({ head: { repo: { full_name: 'x/b' } }, base })).toBe(true)
    expect(fromFork({ head: { repo: null }, base })).toBe(true)
  })
  it('limits requests per window', () => {
    let times: number[] = []
    for (let i = 0; i < 3; i++) {
      const r = withinLimit(times, 1000 + i, 3)
      expect(r.ok).toBe(true)
      times = r.recent
    }
    expect(withinLimit(times, 2000, 3).ok).toBe(false)
    expect(withinLimit(times, 1000 + 3_600_001, 3).ok).toBe(true)
  })
})

describe('triage', () => {
  const rules = { slug: 'beddcode', allowed: ['0xbasinas'] }
  const owner = { login: '0xbasinas', type: 'User' }
  const issueComment = (over: Record<string, unknown> = {}) => ({
    action: 'created',
    installation: { id: 7 },
    repository: { full_name: 'o/r' },
    sender: owner,
    issue: { number: 3 },
    comment: { id: 11, body: '@beddcode fix this', user: owner },
    ...over,
  })
  it('accepts the owner commenting a command on an issue', () => {
    const r = triage('issue_comment', issueComment(), rules)
    expect(r).toMatchObject({
      ok: true,
      request: { repo: 'o/r', number: 3, isPullRequest: false, commentId: 11 },
    })
  })
  it('ignores an outsider, edits, bots and other events', () => {
    const stranger = { login: 'mallory', type: 'User' }
    expect(
      triage(
        'issue_comment',
        issueComment({
          sender: stranger,
          comment: { id: 1, body: '@beddcode fix this', user: stranger },
        }),
        rules,
      ).ok,
    ).toBe(false)
    expect(triage('issue_comment', issueComment({ action: 'edited' }), rules).ok).toBe(false)
    expect(
      triage(
        'issue_comment',
        issueComment({ sender: { login: 'beddcode[bot]', type: 'Bot' } }),
        rules,
      ).ok,
    ).toBe(false)
    expect(triage('push', issueComment(), rules).ok).toBe(false)
    expect(triage('issue_comment', issueComment({ installation: undefined }), rules).ok).toBe(false)
  })
  it('ignores a comment by an outsider even if the sender field claims to be the owner', () => {
    const stranger = { login: 'mallory', type: 'User' }
    expect(
      triage(
        'issue_comment',
        issueComment({ comment: { id: 1, body: '@beddcode fix this', user: stranger } }),
        rules,
      ).ok,
    ).toBe(false)
  })
  it('ignores review comments on fork pull requests', () => {
    const pr = (head: string) => ({
      action: 'created',
      installation: { id: 7 },
      repository: { full_name: 'o/r' },
      sender: owner,
      pull_request: {
        number: 5,
        head: { ref: 'x', sha: 'abc', repo: { full_name: head } },
        base: { ref: 'main', repo: { full_name: 'o/r' } },
      },
      comment: { id: 2, body: '@beddcode review', user: owner },
    })
    expect(triage('pull_request_review_comment', pr('o/r'), rules).ok).toBe(true)
    expect(triage('pull_request_review_comment', pr('evil/r'), rules).ok).toBe(false)
  })
})

describe('label triggers', () => {
  const rules = { slug: 'beddcode', allowed: ['0xbasinas'] }
  const owner = { login: '0xbasinas', type: 'User' }
  const labeled = (event: 'issues' | 'pull_request', name: string, sender = owner) => ({
    action: 'labeled',
    installation: { id: 7 },
    repository: { full_name: 'o/r' },
    sender,
    label: { name },
    issue: { number: 3, html_url: 'u' },
    pull_request: {
      number: 5,
      html_url: 'u',
      head: { ref: 'f', sha: 'a', repo: { full_name: 'o/r' } },
      base: { ref: 'main', repo: { full_name: 'o/r' } },
    },
  })
  it('fixes a labeled issue and reviews a labeled pull request', () => {
    expect(triage('issues', labeled('issues', 'beddcode'), rules)).toMatchObject({
      ok: true,
      request: { number: 3, commentKind: 'thread', command: { verb: 'fix' } },
    })
    expect(triage('pull_request', labeled('pull_request', 'beddcode'), rules)).toMatchObject({
      ok: true,
      request: { number: 5, isPullRequest: true, command: { verb: 'review' } },
    })
    expect(triage('issues', labeled('issues', 'beddcode:explain'), rules)).toMatchObject({
      ok: true,
      request: { command: { verb: 'explain' } },
    })
  })
  it('ignores other labels and labels applied by anyone else', () => {
    expect(triage('issues', labeled('issues', 'bug'), rules).ok).toBe(false)
    expect(
      triage('issues', labeled('issues', 'beddcode', { login: 'mallory', type: 'User' }), rules).ok,
    ).toBe(false)
  })
})

describe('commands in a new issue', () => {
  const rules = { slug: 'beddcode', allowed: ['0xbasinas'] }
  const owner = { login: '0xbasinas', type: 'User' }
  const opened = (body: string, user = owner) => ({
    action: 'opened',
    installation: { id: 7 },
    repository: { full_name: 'o/r' },
    sender: user,
    issue: { number: 104, html_url: 'u', body, user },
  })
  it('starts a job from the issue text, as plain words for the agent', () => {
    expect(
      triage(
        'issues',
        opened('@beddcode please make the composer less tall slightly, use sonnet 5.5 on medium'),
        rules,
      ),
    ).toMatchObject({
      ok: true,
      request: {
        number: 104,
        commentKind: 'thread',
        command: { verb: 'ask', model: 'sonnet', effort: 'medium' },
      },
    })
  })
  it('ignores strangers and issues that do not mention the app', () => {
    expect(
      triage('issues', opened('@beddcode fix this', { login: 'mallory', type: 'User' }), rules).ok,
    ).toBe(false)
    expect(triage('issues', opened('the composer is too tall'), rules).ok).toBe(false)
  })
})

describe('appJwt', () => {
  it('signs with a PKCS#1 key as GitHub hands them out', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const pkcs1 = privateKey.export({ type: 'pkcs1', format: 'pem' }) as string
    const pkcs8 = privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer
    expect(Buffer.from(pemToPkcs8(pkcs1)).equals(pkcs8)).toBe(true)
    const jwt = await appJwt('123', pkcs1)
    const [head, claims] = jwt.split('.')
    expect(JSON.parse(atob(head!.replace(/-/g, '+').replace(/_/g, '/')))).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    })
    expect(JSON.parse(atob(claims!.replace(/-/g, '+').replace(/_/g, '/'))).iss).toBe('123')
  })
})
