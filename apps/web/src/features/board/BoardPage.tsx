import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { isWaitingOnYou, type SessionView } from '@beddcode/client-runtime'
import { setSessionBoardStage, useAllSessions, useHostStore } from '../../stores/host.ts'
import { folderName } from '../../ui/format.ts'
import { Select } from '../../ui/Select.tsx'
import './board.css'

const stages = [
  ['pending', 'Up next'],
  ['in-progress', 'Working'],
  ['review', 'Needs review'],
  ['done', 'Completed'],
] as const

type Stage = NonNullable<SessionView['boardStage']>

// Sessions never moved by hand: live ones are "Working", finished conversations are "Completed".
function defaultStage(session: SessionView): Stage {
  if (session.boardStage) return session.boardStage
  return session.status === 'running' || isWaitingOnYou(session) ? 'in-progress' : 'done'
}

export function BoardPage() {
  const sessions = useAllSessions()
  const entries = useHostStore((s) => s.entries)
  const [project, setProject] = useState('all')
  const [error, setError] = useState('')
  const projectKey = (hostKey: string, s: SessionView) =>
    JSON.stringify([hostKey, s.projectless ? '' : s.projectPath])
  const projects = new Map(
    sessions.map(({ hostKey, session }) => [
      projectKey(hostKey, session),
      {
        name: session.projectless ? 'No project' : folderName(session.projectPath),
        host: entries.find((e) => e.key === hostKey)?.name ?? hostKey,
      },
    ]),
  )
  const visible = sessions.filter(
    ({ hostKey, session }) => project === 'all' || projectKey(hostKey, session) === project,
  )
  const move = async (id: string, stage: Stage) => {
    setError('')
    try {
      await setSessionBoardStage(id, stage)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not move task')
    }
  }
  return (
    <main className="board-page">
      <header className="board-header">
        <div>
          <h1>Task board</h1>
          <p>
            Organize sessions for your own review. Moving a task does not start or stop an agent.
          </p>
        </div>
        <label>
          Project{' '}
          <Select value={project} onChange={(e) => setProject(e.target.value)}>
            <option value="all">All projects</option>
            {[...projects].map(([key, value]) => (
              <option key={key} value={key}>
                {value.name} · {value.host}
              </option>
            ))}
          </Select>
        </label>
      </header>
      {error && (
        <p role="alert" className="board-error">
          {error}
        </p>
      )}
      <div className="board-columns">
        {stages.map(([stage, label]) => {
          const cards = visible.filter(({ session }) => defaultStage(session) === stage)
          return (
            <section className="board-column" key={stage} aria-label={label}>
              <h2>
                {label} <span>{cards.length}</span>
              </h2>
              {cards.map(({ hostKey, session }) => (
                <article className="board-card" key={`${hostKey}:${session.id}`}>
                  <Link to="/session/$sessionId" params={{ sessionId: session.id }}>
                    {session.title}
                  </Link>
                  <div className="board-meta">
                    {session.projectless ? 'No project' : folderName(session.projectPath)} ·{' '}
                    {entries.find((e) => e.key === hostKey)?.name ?? hostKey}
                  </div>
                  <div className="board-meta">
                    {isWaitingOnYou(session)
                      ? 'Needs you'
                      : session.status === 'idle'
                        ? 'Idle'
                        : session.status === 'running'
                          ? 'Running'
                          : 'Failed'}
                  </div>
                  <label>
                    Stage{' '}
                    <Select
                      aria-label={`Stage for ${session.title}`}
                      value={stage}
                      onChange={(e) => void move(session.id, e.target.value as Stage)}
                    >
                      {stages.map(([value, name]) => (
                        <option key={value} value={value}>
                          {name}
                        </option>
                      ))}
                    </Select>
                  </label>
                </article>
              ))}
              {cards.length === 0 && <p className="board-empty">No tasks</p>}
            </section>
          )
        })}
      </div>
    </main>
  )
}
