import { readFileSync } from 'node:fs'
import { writeFileAtomic } from '@beddcode/shared'
import type { Schedule, ScheduleRun } from '@beddcode/contracts'
import type { LinearKeyStore } from './linearTools.ts'

const ENDPOINT = 'https://api.linear.app/graphql'

export interface LinearSyncSettings {
  /** File a Linear issue in `teamId` when a scheduled task fails. */
  fileFailedRuns: boolean
  teamId?: string
}

type Fetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

/** What the host does in Linear by itself, with the key the user connected. Off until switched on. */
export class LinearSync {
  private settings: LinearSyncSettings = { fileFailedRuns: false }

  constructor(
    private readonly file: string,
    private readonly keys: LinearKeyStore,
    private readonly fetchImpl: Fetch = (url, init) => fetch(url, init),
  ) {
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8')) as Partial<LinearSyncSettings>
      this.settings = {
        fileFailedRuns: saved.fileFailedRuns === true,
        teamId: typeof saved.teamId === 'string' ? saved.teamId : undefined,
      }
    } catch {
      // Nothing saved yet.
    }
  }

  get(): LinearSyncSettings {
    return this.settings
  }

  set(settings: LinearSyncSettings): LinearSyncSettings {
    this.settings = {
      fileFailedRuns: settings.fileFailedRuns,
      teamId: settings.teamId || undefined,
    }
    writeFileAtomic(this.file, JSON.stringify(this.settings))
    return this.settings
  }

  /** Files an issue for a run that failed, if that is switched on; never throws. */
  async onRunEnded(run: ScheduleRun, schedule: Schedule): Promise<void> {
    const { fileFailedRuns, teamId } = this.settings
    const key = this.keys.get()
    if (!fileFailedRuns || !teamId || !key || run.status !== 'error') return
    const description = [
      `The scheduled task **${schedule.name}** failed${run.retry ? ' (after a retry)' : ''}.`,
      run.note ? `\n> ${run.note}` : '',
      `\nIt ran at ${new Date(run.startedAt).toISOString()}.`,
      '\nFiled by BeddCode.',
    ].join('\n')
    try {
      await this.fetchImpl(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: key },
        body: JSON.stringify({
          query:
            'mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { identifier } } }',
          variables: {
            input: { teamId, title: `Scheduled task failed: ${schedule.name}`, description },
          },
        }),
      })
    } catch {
      // Linear being unreachable must not disturb the schedule.
    }
  }
}
