import { JobQueue } from './queue.ts'
import { Github, type GithubEnv } from './github.ts'
import { parseList } from './policy.ts'
import type { HostHello, Job, JobReport } from './protocol.ts'
import { sameSecret, verifyWebhook } from './signature.ts'
import { triage, type Request as AskRequest } from './webhook.ts'

export { JobQueue }

export interface Env extends GithubEnv {
  QUEUE: DurableObjectNamespace<JobQueue>
  GITHUB_WEBHOOK_SECRET?: string
  /** Shared with your hosts (`github.json`). Hosts present it on every call. */
  HOST_TOKEN?: string
  ALLOWED_USERS?: string
  APP_SLUG?: string
  MAX_JOBS_PER_HOUR?: string
  JOB_MINUTES?: string
  HOST_STALE_SECONDS?: string
  REPLY_WHEN_OFFLINE?: string
}

const MAX_BODY = 1_000_000
const MAX_CONTEXT = 24_000

const num = (value: string | undefined, fallback: number) => {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}
const queueOf = (env: Env) => env.QUEUE.get(env.QUEUE.idFromName('main'))

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/health') return new Response('ok')
    if (url.pathname === '/webhook' && request.method === 'POST') return webhook(request, env, ctx)
    if (url.pathname.startsWith('/host/')) return host(request, url, env)
    return new Response('Not found', { status: 404 })
  },
} satisfies ExportedHandler<Env>

async function webhook(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const text = await request.text()
  if (text.length > MAX_BODY) return new Response('Too large', { status: 413 })
  if (!(await verifyWebhook(env.GITHUB_WEBHOOK_SECRET, text, request.headers.get('x-hub-signature-256'))))
    return new Response('Unauthorized', { status: 401 })
  let payload: Parameters<typeof triage>[1]
  try {
    payload = JSON.parse(text)
  } catch {
    return new Response('Bad request', { status: 400 })
  }
  const result = triage(request.headers.get('x-github-event') ?? '', payload, {
    slug: env.APP_SLUG ?? 'beddcode',
    allowed: parseList(env.ALLOWED_USERS),
  })
  // Ignored deliveries get the same quiet 202, so outsiders learn nothing about the rules.
  if (!result.ok) return new Response('ignored', { status: 202 })
  ctx.waitUntil(
    accept(env, result.request).catch((err) => console.error('accept failed', String(err))),
  )
  return new Response('accepted', { status: 202 })
}

/** Builds the job's context, queues it, and tells the sender what happened. */
async function accept(env: Env, ask: AskRequest): Promise<void> {
  const github = new Github(env)
  const token = await github.token(ask.installationId)
  const queue = queueOf(env)
  const react = (content: string) =>
    github.react(token, ask.repo, ask.commentId, ask.commentKind, content).catch(() => undefined)
  const say = (body: string) => github.comment(token, ask.repo, ask.number, body).catch(() => undefined)

  if (!(await queue.admit(ask.sender, num(env.MAX_JOBS_PER_HOUR, 10))))
    return void (await say(`@${ask.sender} that is more than ${num(env.MAX_JOBS_PER_HOUR, 10)} requests this hour. Try again later.`))

  if (ask.command.verb === 'help')
    return void (await say(`@${ask.sender} I did not find a command in that. Try one of:

- \`@${env.APP_SLUG ?? 'beddcode'} fix this\`
- \`@${env.APP_SLUG ?? 'beddcode'} review\` / \`explain\`
- \`@${env.APP_SLUG ?? 'beddcode'} fix ci\`
- \`@${env.APP_SLUG ?? 'beddcode'} rebase on main\`
- \`@${env.APP_SLUG ?? 'beddcode'} stop\`

Add an agent, model or effort anywhere: \`codex\`, \`model=sonnet\`, \`effort=high\`, or in words like "with claude on sonnet, low effort".`))

  let head: Job['head']
  let base: Job['base']
  if (ask.isPullRequest) {
    const pr = ask.pull?.head?.repo ? ask.pull : await github.pull(token, ask.repo, ask.number)
    const prHead = pr?.head
    if (!prHead?.repo?.full_name || prHead.repo.full_name.toLowerCase() !== ask.repo.toLowerCase())
      return // A fork: ignored.
    head = { ref: prHead.ref ?? '', sha: prHead.sha ?? '' }
    base = { ref: pr.base?.ref ?? 'main' }
  } else {
    base = { ref: await github.defaultBranch(token, ask.repo) }
  }

  const issue = await github.issue(token, ask.repo, ask.number)
  const comments = await github.comments(token, ask.repo, ask.number).catch(() => [])
  const parts = [
    `# ${ask.isPullRequest ? 'Pull request' : 'Issue'} #${ask.number}: ${issue.title}`,
    `Opened by ${issue.user.login}`,
    issue.body ?? '(no description)',
    ...comments.slice(-15).map((c) => `--- ${c.user.login} wrote:\n${c.body}`),
  ]
  if (ask.command.verb === 'fix-ci' && head)
    parts.push(`## Failing checks on ${head.sha.slice(0, 7)}\n${await github.failedChecks(token, ask.repo, head.sha)}`)

  const job: Job = {
    id: crypto.randomUUID(),
    repo: ask.repo,
    installationId: ask.installationId,
    number: ask.number,
    isPullRequest: ask.isPullRequest,
    command: ask.command,
    sender: ask.sender,
    commentId: ask.commentId,
    commentKind: ask.commentKind,
    context: parts.join('\n\n').slice(0, MAX_CONTEXT),
    head,
    base,
    url: ask.url,
    budgetMinutes: num(env.JOB_MINUTES, 30),
    createdAt: Date.now(),
  }
  const hostLabel = await queue.enqueue(job, num(env.HOST_STALE_SECONDS, 90))
  if (hostLabel) return void (await react('eyes'))
  if (env.REPLY_WHEN_OFFLINE !== 'false')
    await say(
      `@${ask.sender} none of your BeddCode hosts that serve \`${ask.repo}\` are online right now, so I did not start. Open BeddCode on a host and comment again.`,
    )
}

function hostAuth(request: Request, env: Env): boolean {
  const given = /^Bearer (.+)$/.exec(request.headers.get('authorization') ?? '')?.[1] ?? ''
  return !!env.HOST_TOKEN && env.HOST_TOKEN.length >= 24 && sameSecret(env.HOST_TOKEN, given)
}

const json = (value: unknown, status = 200) => Response.json(value, { status })

/** What hosts call: poll for work, report progress, and get a narrow token to push with. */
async function host(request: Request, url: URL, env: Env): Promise<Response> {
  if (!hostAuth(request, env)) return new Response('Unauthorized', { status: 401 })
  const queue = queueOf(env)
  const stale = num(env.HOST_STALE_SECONDS, 90)
  if (url.pathname === '/host/poll' && request.method === 'POST') {
    const hello = (await request.json().catch(() => null)) as HostHello | null
    if (!hello || typeof hello.id !== 'string' || !Array.isArray(hello.repos)) return new Response('Bad request', { status: 400 })
    const wait = Math.min(25_000, num(url.searchParams.get('wait') ?? '', 0) * 1000)
    const { jobs, expired } = await queue.poll(
      { id: hello.id.slice(0, 64), label: String(hello.label).slice(0, 64), repos: hello.repos.map(String).slice(0, 200), priority: Number(hello.priority) || 0 },
      stale,
      wait,
    )
    if (expired.length > 0) {
      const github = new Github(env)
      for (const job of expired)
        await github
          .token(job.installationId)
          .then((t) => github.comment(t, job.repo, job.number, `@${job.sender} no host picked this up in time. Comment again when one is online.`))
          .catch(() => undefined)
    }
    return json({ jobs })
  }
  const match = /^\/host\/jobs\/([0-9a-f-]{36})\/(report|token|pr)$/.exec(url.pathname)
  if (!match || request.method !== 'POST') return new Response('Not found', { status: 404 })
  const hostId = request.headers.get('x-host-id') ?? ''
  const job = await queue.claimed(match[1]!, hostId)
  if (!job) return new Response('No such job', { status: 404 })
  const github = new Github(env)
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
  if (match[2] === 'token') {
    // Only this repository, only what a push and a pull request need.
    const token = await github.token(job.installationId, {
      repo: job.repo,
      permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' },
    })
    return json({ token })
  }
  const token = await github.token(job.installationId)
  if (match[2] === 'pr') {
    const pr = await github.openPull(token, job.repo, {
      title: String(body.title ?? `BeddCode: #${job.number}`).slice(0, 250),
      body: String(body.body ?? '').slice(0, 20_000),
      head: String(body.head ?? ''),
      base: String(body.base ?? job.base?.ref ?? 'main'),
      draft: body.draft === true,
    })
    return json({ url: pr.html_url, number: pr.number })
  }
  const report = body as unknown as JobReport
  const reaction = { started: 'eyes', done: 'rocket', failed: 'confused', refused: 'confused', stopped: '-1', working: '' }[report.status]
  if (reaction) await github.react(token, job.repo, job.commentId, job.commentKind, reaction).catch(() => undefined)
  if (report.message) await github.comment(token, job.repo, job.number, String(report.message).slice(0, 60_000))
  if (['done', 'failed', 'stopped', 'refused'].includes(report.status)) await queue.finish(job.id)
  return json({ ok: true })
}
