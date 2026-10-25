import { useMemo, useState } from 'react'
import { MousePointer2, Plus } from 'lucide-react'
import { useEditorStore } from './store/editor-store'
import { findElementInList } from './lib/element-utils'
import { Composer } from '../composer/Composer.tsx'
import { ModelMenu } from '../composer/Menus.tsx'
import { ThreadView } from '../thread/ThreadView.tsx'
import { Select } from '../../ui/Select.tsx'
import { modelChoice } from '../../ui/models.ts'
import { createSession, prompt, useAllSessions, useRuntime } from '../../stores/host.ts'
import { agentDefaults, defaultAgent, hostDefaults, usePreferences } from '../../stores/preferences.ts'

const NEW = 'new'

/** What is selected on the canvas, which the agent can read with design_get_selection. */
function SelectionStrip() {
  const names = useEditorStore((s) =>
    s.selectedElementIds.map((id) => findElementInList(s.elements, id)?.name ?? '').filter(Boolean).join('|'),
  )
  const list = names ? names.split('|') : []
  if (list.length === 0) return null
  return (
    <div className="design-agent-selection" title="The agent can see this selection">
      <MousePointer2 size={12} />
      <span>
        Agent sees: {list.slice(0, 3).join(', ')}
        {list.length > 3 ? ` +${list.length - 3}` : ''}
      </span>
    </div>
  )
}

/**
 * An agent next to the canvas: the conversation of a session that has the design tools, so the
 * user can steer the drawing without leaving the Design screen. With none yet, the box starts one.
 */
export function DesignAgentPanel({ hostKey }: { hostKey: string }) {
  const { providers, host } = useRuntime(hostKey)
  const all = useAllSessions()
  const sessions = useMemo(
    () => all.filter((s) => s.hostKey === hostKey && s.session.designTools).map((s) => s.session),
    [all, hostKey],
  )
  const [picked, setPicked] = useState<string>()
  const [text, setText] = useState('')
  const defaults = usePreferences((s) => hostDefaults(s.hosts, host?.hostId ?? hostKey))

  const shown = picked === NEW ? undefined : (sessions.find((s) => s.id === picked) ?? sessions[0])
  const agent = defaultAgent(providers, defaults.instanceId)
  const saved = agentDefaults(defaults, agent)
  const choice = modelChoice(
    agent?.capabilities.models ?? [],
    agent?.capabilities.efforts ?? [],
    { model: saved.model, effort: saved.effort },
  )
  const [chosen, setChosen] = useState<typeof choice>()
  const pick = chosen ?? choice

  const start = async (value: string, attachments: string[]) => {
    if (!agent) throw new Error('No agent is ready on this host')
    const sessionId = await createSession(hostKey, {
      instanceId: agent.id,
      projectless: true,
      permissionMode: saved.permissionMode,
      model: pick.model,
      effort: pick.effort,
      designTools: true,
    })
    await prompt(sessionId, value, attachments)
    setPicked(sessionId)
    setText('')
  }

  return (
    <aside className="design-agent" aria-label="Design agent">
      <div className="design-agent-bar">
        <Select
          aria-label="Agent session"
          value={shown?.id ?? NEW}
          onChange={(e) => setPicked(e.target.value)}
        >
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title}
            </option>
          ))}
          {sessions.length === 0 && <option value={NEW}>New agent chat</option>}
        </Select>
        <button
          type="button"
          className="design-bar-btn"
          title="New agent chat"
          aria-label="New agent chat"
          onClick={() => setPicked(NEW)}
        >
          <Plus size={14} />
        </button>
      </div>
      <SelectionStrip />
      {shown ? (
        <ThreadView key={shown.id} sessionId={shown.id} />
      ) : (
        <div className="design-agent-new">
          <div className="design-agent-intro">
            <strong>Design with an agent</strong>
            <span>
              Describe what to draw. The agent works on the open canvas and you watch it appear.
            </span>
          </div>
          <Composer
            draftId="design-agent"
            hostKey={hostKey}
            text={text}
            onTextChange={setText}
            placeholder={agent ? 'Describe a design…' : 'No agent is ready on this host'}
            disabled={!agent}
            busy={false}
            onSend={start}
            modelSlot={
              (agent?.capabilities.models?.length ?? 0) > 0 ? (
                <ModelMenu
                  models={agent?.capabilities.models ?? []}
                  efforts={agent?.capabilities.efforts ?? []}
                  value={pick}
                  onChange={setChosen}
                />
              ) : undefined
            }
          />
        </div>
      )}
    </aside>
  )
}
