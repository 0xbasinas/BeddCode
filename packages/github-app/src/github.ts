import { appJwt } from './githubAuth.ts'

const API = 'https://api.github.com'

export interface GithubEnv {
  GITHUB_APP_ID?: string
  GITHUB_APP_PRIVATE_KEY?: string
}

type Fetch = typeof fetch

const headers = (token: string) => ({
  authorization: `Bearer ${token}`,
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'user-agent': 'beddcode-github',
})

/** The GitHub API as the app, for one installation. Tokens are short-lived and scoped to what is asked. */
export class Github {
  constructor(
    private readonly env: GithubEnv,
    private readonly doFetch: Fetch = (input, init) => fetch(input, init),
  ) {}

  /**
   * An installation token. Narrow it to one repository and the permissions a job needs; a host
   * that gets one can push to that repository for about an hour and nothing else.
   */
  async token(
    installationId: number,
    scope?: { repo: string; permissions: Record<string, 'read' | 'write'> },
  ): Promise<string> {
    const { GITHUB_APP_ID: id, GITHUB_APP_PRIVATE_KEY: key } = this.env
    if (!id || !key) throw new Error('GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY are not set')
    const jwt = await appJwt(id, key)
    const response = await this.doFetch(
      `${API}/app/installations/${installationId}/access_tokens`,
      {
        method: 'POST',
        headers: { ...headers(jwt), 'content-type': 'application/json' },
        body: JSON.stringify(
          scope ? { repositories: [scope.repo.split('/')[1]], permissions: scope.permissions } : {},
        ),
      },
    )
    if (!response.ok) throw new Error(`GitHub refused a token (${response.status})`)
    return ((await response.json()) as { token: string }).token
  }

  private async call<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.doFetch(`${API}${path}`, {
      method,
      headers: { ...headers(token), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })
    if (!response.ok) throw new Error(`GitHub ${method} ${path} failed (${response.status})`)
    const text = await response.text()
    return (text ? JSON.parse(text) : undefined) as T
  }

  comment(token: string, repo: string, number: number, body: string) {
    return this.call<{ html_url: string }>(
      token,
      'POST',
      `/repos/${repo}/issues/${number}/comments`,
      {
        body,
      },
    )
  }

  react(
    token: string,
    repo: string,
    target: { kind: 'issue' | 'review' | 'thread'; id: number; number: number },
    content: string,
  ) {
    const path =
      target.kind === 'review'
        ? `/repos/${repo}/pulls/comments/${target.id}/reactions`
        : target.kind === 'thread'
          ? `/repos/${repo}/issues/${target.number}/reactions`
          : `/repos/${repo}/issues/comments/${target.id}/reactions`
    return this.call(token, 'POST', path, { content })
  }

  issue(token: string, repo: string, number: number) {
    return this.call<{
      title: string
      body: string | null
      state: string
      user: { login: string }
    }>(token, 'GET', `/repos/${repo}/issues/${number}`)
  }

  comments(token: string, repo: string, number: number) {
    return this.call<{ user: { login: string }; body: string }[]>(
      token,
      'GET',
      `/repos/${repo}/issues/${number}/comments?per_page=30`,
    )
  }

  pull(token: string, repo: string, number: number) {
    return this.call<{
      head: { ref: string; sha: string; repo: { full_name: string } | null }
      base: { ref: string; repo: { full_name: string } }
    }>(token, 'GET', `/repos/${repo}/pulls/${number}`)
  }

  defaultBranch(token: string, repo: string) {
    return this.call<{ default_branch: string }>(token, 'GET', `/repos/${repo}`).then(
      (r) => r.default_branch,
    )
  }

  openPull(
    token: string,
    repo: string,
    pr: { title: string; body: string; head: string; base: string; draft?: boolean },
  ) {
    return this.call<{ html_url: string; number: number }>(
      token,
      'POST',
      `/repos/${repo}/pulls`,
      pr,
    )
  }

  /** The tail of the logs of failed jobs in the latest failed check runs for a commit. */
  async failedChecks(token: string, repo: string, sha: string, maxChars = 12_000): Promise<string> {
    const runs = await this.call<{
      check_runs: {
        id: number
        name: string
        conclusion: string | null
        output: { title?: string; summary?: string; text?: string }
      }[]
    }>(token, 'GET', `/repos/${repo}/commits/${sha}/check-runs?per_page=50`)
    const failed = runs.check_runs.filter((r) =>
      ['failure', 'timed_out', 'cancelled', 'action_required'].includes(r.conclusion ?? ''),
    )
    const parts: string[] = []
    for (const run of failed.slice(0, 5)) {
      let log = ''
      try {
        const response = await this.doFetch(`${API}/repos/${repo}/actions/jobs/${run.id}/logs`, {
          headers: headers(token),
          redirect: 'follow',
        })
        if (response.ok) log = (await response.text()).slice(-maxChars / 2)
      } catch {
        // Not an Actions job, or the log expired; fall back to the check's own output.
      }
      const fallback = [run.output.title, run.output.summary, run.output.text]
        .filter(Boolean)
        .join('\n')
      parts.push(`### ${run.name} (${run.conclusion})\n${(log || fallback).slice(-maxChars / 2)}`)
    }
    return parts.length ? parts.join('\n\n').slice(-maxChars) : 'No failed checks were found.'
  }
}
