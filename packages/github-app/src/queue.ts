import { DurableObject } from 'cloudflare:workers'
import type { HostHello, Job } from './protocol.ts'
import { withinLimit } from './policy.ts'

/** A queued job waits this long for a host before it is dropped. */
export const JOB_TTL_MS = 15 * 60_000

interface Seen extends HostHello {
  seen: number
}

export const serves = (hello: Pick<HostHello, 'repos'>, repo: string) =>
  hello.repos.some((r) => r === '*' || r.toLowerCase() === repo.toLowerCase())

/**
 * The jobs waiting for your hosts. Hosts come to it (they poll), so nothing needs a public address
 * and no code runs here: it only holds a job's text until a host takes it. It also keeps who is
 * online and each sender's recent requests.
 */
export class JobQueue extends DurableObject {
  /** Is some online host serving this repo, and which one comes first? */
  private async pick(repo: string, staleMs: number, now: number): Promise<Seen | undefined> {
    const hosts = [...(await this.ctx.storage.list<Seen>({ prefix: 'host:' })).values()]
    return hosts
      .filter((h) => now - h.seen < staleMs && serves(h, repo))
      .sort((a, b) => a.priority - b.priority || b.seen - a.seen)[0]
  }

  /** May this sender ask again? Counts the request when it may. */
  async admit(sender: string, limit: number, now = Date.now()): Promise<boolean> {
    const key = `rate:${sender.toLowerCase()}`
    const result = withinLimit((await this.ctx.storage.get<number[]>(key)) ?? [], now, limit)
    await this.ctx.storage.put(key, result.recent)
    return result.ok
  }

  /**
   * Queues a job for the best online host. A `stop` goes to the host that is working on that
   * thread. Returns the host's name, or undefined when none is online.
   */
  async enqueue(job: Job, staleSeconds: number, now = Date.now()): Promise<string | undefined> {
    const thread = `${job.repo}#${job.number}`.toLowerCase()
    let host: Seen | undefined
    if (job.command.verb === 'stop') {
      const active = await this.ctx.storage.get<string>(`active:${thread}`)
      if (active) host = await this.ctx.storage.get<Seen>(`host:${active}`)
    }
    host ??= await this.pick(job.repo, staleSeconds * 1000, now)
    if (!host) return undefined
    job.host = host.id
    await this.ctx.storage.put(`job:${job.id}`, job)
    return host.label
  }

  /**
   * A host asks for work. Waits up to `waitMs` for a job. Jobs assigned to a host that has since
   * gone quiet are taken over by another host serving the repo.
   */
  async poll(
    hello: HostHello,
    staleSeconds: number,
    waitMs: number,
    now = Date.now(),
  ): Promise<{ jobs: Job[]; expired: Job[] }> {
    await this.ctx.storage.put(`host:${hello.id}`, { ...hello, seen: now } satisfies Seen)
    const deadline = now + waitMs
    for (;;) {
      const at = Date.now()
      const expired: Job[] = []
      const mine: Job[] = []
      const jobs = await this.ctx.storage.list<Job>({ prefix: 'job:' })
      for (const [key, job] of jobs) {
        if (at - job.createdAt > JOB_TTL_MS) {
          expired.push(job)
          await this.ctx.storage.delete(key)
          continue
        }
        const owner = job.host ? await this.ctx.storage.get<Seen>(`host:${job.host}`) : undefined
        const abandoned = !owner || at - owner.seen > staleSeconds * 1000
        if (job.host === hello.id || (abandoned && serves(hello, job.repo))) {
          mine.push(job)
          await this.ctx.storage.delete(key)
          await this.ctx.storage.put(`claimed:${job.id}`, { job: { ...job, host: hello.id }, at })
          if (job.command.verb !== 'stop')
            await this.ctx.storage.put(`active:${job.repo}#${job.number}`.toLowerCase(), hello.id)
        }
      }
      if (mine.length > 0 || expired.length > 0 || at >= deadline) return { jobs: mine, expired }
      await new Promise((resolve) => setTimeout(resolve, 1000))
      await this.ctx.storage.put(`host:${hello.id}`, { ...hello, seen: Date.now() } satisfies Seen)
    }
  }

  /** The job a host claimed, if that is this host. Lets the Worker check a host's request is about its own job. */
  async claimed(jobId: string, hostId: string): Promise<Job | undefined> {
    const entry = await this.ctx.storage.get<{ job: Job }>(`claimed:${jobId}`)
    return entry?.job.host === hostId ? entry.job : undefined
  }

  /** The host is done with a job; forget it. */
  async finish(jobId: string): Promise<void> {
    const entry = await this.ctx.storage.get<{ job: Job }>(`claimed:${jobId}`)
    await this.ctx.storage.delete(`claimed:${jobId}`)
    if (entry) await this.ctx.storage.delete(`active:${entry.job.repo}#${entry.job.number}`.toLowerCase())
  }

  async online(staleSeconds: number, now = Date.now()): Promise<{ label: string; repos: string[] }[]> {
    const hosts = [...(await this.ctx.storage.list<Seen>({ prefix: 'host:' })).values()]
    return hosts.filter((h) => now - h.seen < staleSeconds * 1000).map((h) => ({ label: h.label, repos: h.repos }))
  }
}
