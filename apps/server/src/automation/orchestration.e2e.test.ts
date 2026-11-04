import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { createFakeAdapter } from '@beddcode/provider-core'
import { createLogger } from '@beddcode/shared'
import { AttachmentStore } from '../attachments/store.ts'
import { SessionManager } from '../sessions/sessionManager.ts'
import { EventStore } from '../store/eventStore.ts'
import { TerminalManager } from '../terminals/manager.ts'
import { GitService } from '../workspace/git.ts'
import { ProjectStore } from '../workspace/projects.ts'
import { createAutomation } from './index.ts'

// Uses the same real session manager, automation wiring and fake provider as the server harness.
function boot(home: string, project: string) {
  const store = new EventStore(path.join(home, 'events.db'))
  const git = new GitService()
  const terminals = new TerminalManager()
  let automation: ReturnType<typeof createAutomation> | undefined
  const sessions = new SessionManager({
    agentToolServers: (id) => automation?.agentTools.serversFor(id) ?? [],
    attachments: new AttachmentStore(path.join(home, 'attachments')),
    git,
    store,
    adapters: [createFakeAdapter({ delayMs: 0, advanced: true })],
    log: createLogger('test', 'error'),
    defaultCwd: project,
  })
  automation = createAutomation({
    home,
    hostId: 'test-host',
    sessions,
    store,
    workspace: {
      git,
      terminals,
      projects: new ProjectStore(path.join(home, 'projects.json'), git),
    },
    port: () => 0,
  })
  const active = automation
  return {
    store,
    sessions,
    automation: active,
    async close() {
      active.stop()
      await sessions.close()
      await terminals.shutdown()
      store.close()
    },
  }
}

async function call(host: ReturnType<typeof boot>, session: string, name: string, args: object) {
  const result = (await host.automation.agentTools.handle(session, 'tools/call', {
    name,
    arguments: args,
  })) as { isError?: boolean; content: { text: string }[] }
  const text = result.content[0]!.text
  if (result.isError) throw new Error(text)
  return JSON.parse(text)
}

it('orchestrates workers, approvals and durable messages across a host restart', async () => {
  const root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'orchestration-e2e-')))
  const project = path.join(root, 'project')
  mkdirSync(project)
  const git = (...args: string[]) => execFileSync('git', args, { cwd: project })
  let host: ReturnType<typeof boot> | undefined
  try {
    git('init', '-q', '-b', 'main')
    git('config', 'user.name', 'Test')
    git('config', 'user.email', 'test@example.com')
    writeFileSync(path.join(project, 'initial.txt'), 'initial\n')
    git('add', '.')
    git('commit', '-q', '-m', 'initial')
    host = boot(root, project)
    const settings = host.automation.orchestration.get()
    Object.assign(settings.global, {
      maxWorkers: 2,
      maxTotalWorkers: 2,
      maxMessages: 2,
      approval: 'approve-spawns',
    })
    host.automation.orchestration.set(settings)
    const { sessionId: lead } = await host.sessions.create(
      { instanceId: 'fake', cwd: project, permissionMode: 'full', agentTools: true },
      {},
    )
    const planPromise = call(host, lead, 'create_orchestration_plan', {
      goal: 'Implement and review the change',
      tasks: [
        { agent: 'fake', prompt: 'Implement', worktree: true },
        { agent: 'fake', prompt: 'Review', worktree: true },
      ],
    })
    for (let i = 0; i < 2; i++) {
      await vi.waitFor(() =>
        expect(
          host!.automation.orchestration.list().filter((a) => a.status === 'pending'),
        ).toHaveLength(1),
      )
      const pending = host.automation.orchestration.list().find((a) => a.status === 'pending')!
      expect(pending).toMatchObject({ sessionId: lead, kind: 'spawn' })
      host.automation.orchestration.resolve(pending.id, 'approved')
    }
    const plan = (await planPromise) as { plan_id: string; tasks: { session_id: string }[] }
    expect(plan.tasks).toHaveLength(2)
    const [first, second] = plan.tasks.map((task) => task.session_id) as [string, string]
    expect(first).not.toBe(second)
    const folders = [first, second].map(
      (id) =>
        host!.store.readSession(id).find(({ event }) => event.type === 'session.created')!.event,
    )
    for (const event of folders) {
      expect(event).toMatchObject({
        type: 'session.created',
        projectPath: project,
        worktree: expect.any(Object),
      })
      if (event.type !== 'session.created') throw new Error('Missing worker')
      expect(event.cwd).not.toBe(project)
    }
    expect(
      folders[0]!.type === 'session.created' &&
        folders[1]!.type === 'session.created' &&
        folders[0].cwd,
    ).not.toBe(folders[1]!.type === 'session.created' && folders[1].cwd)
    await expect(
      call(host, lead, 'start_session', { agent: 'fake', prompt: 'extra' }),
    ).rejects.toThrow(/at most 2/)
    await call(host, first, 'report_result', { status: 'done', summary: 'Implementation complete' })
    const sent = (await call(host, first, 'send_peer_message', {
      session_id: lead,
      text: 'Implementation ready',
    })) as { thread_id: string }
    await call(host, second, 'send_peer_message', { session_id: lead, text: 'Review underway' })
    await host.close()
    host = boot(root, project)
    const recovered = await call(host, lead, 'get_orchestration_plan', {
      plan_id: plan.plan_id,
      start_pending: true,
    })
    expect(recovered).toMatchObject({
      goal: 'Implement and review the change',
      tasks: [
        { session_id: first, status: 'done', result: { summary: 'Implementation complete' } },
        { session_id: second },
      ],
    })
    expect(await call(host, lead, 'read_peer_inbox', {})).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sender_id: first,
          text: 'Implementation ready',
          thread_id: sent.thread_id,
        }),
        expect.objectContaining({ sender_id: second, text: 'Review underway' }),
      ]),
    )
    await call(host, second, 'report_result', { status: 'done', summary: 'Review complete' })
    await call(host, lead, 'send_peer_message', {
      session_id: first,
      text: 'Thanks',
      thread_id: sent.thread_id,
    })
    await expect(
      call(host, first, 'send_peer_message', {
        session_id: lead,
        text: 'Too many',
        thread_id: sent.thread_id,
      }),
    ).rejects.toThrow(/Thread message limit/)
    const final = await call(host, lead, 'get_orchestration_plan', { plan_id: plan.plan_id })
    expect(final.tasks).toMatchObject([
      { status: 'done', result: { summary: 'Implementation complete' } },
      { status: 'done', result: { summary: 'Review complete' } },
    ])
  } finally {
    await host?.close()
    rmSync(root, { recursive: true, force: true })
  }
}, 30_000)
