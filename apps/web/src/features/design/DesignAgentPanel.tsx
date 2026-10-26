import { useEffect, useMemo, useState } from 'react'
import type { AgentPreview, SlashCommand } from '@beddcode/contracts'
import { MousePointer2, Plus } from 'lucide-react'
import { useEditorStore } from './store/editor-store'
import { findElementInList } from './lib/element-utils'
import { Composer } from '../composer/Composer.tsx'
import { ConfigMenu } from '../composer/ConfigMenu.tsx'
import { ModelMenu, type ModelChoice } from '../composer/Menus.tsx'
import { AgentChip } from '../newsession/NewSession.tsx'
import { ThreadView } from '../thread/ThreadView.tsx'
import { Select } from '../../ui/Select.tsx'
import { modelChoice } from '../../ui/models.ts'
import {
  createSession,
  hostRequest,
  prompt,
  readyProviders,
  useAllSessions,
  useRuntime,
} from '../../stores/host.ts'
import {
  agentDefaults,
  defaultAgent,
  hostDefaults,
  usePreferences,
} from '../../stores/preferences.ts'

const NEW = 'new'

/** What is selected on the canvas, which the agent can read with design_get_selection. */
function SelectionStrip() {
  const names = useEditorStore((s) =>
    s.selectedElementIds
      .map((id) => findElementInList(s.elements, id)?.name ?? '')
      .filter(Boolean)
      .join('|'),
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
  const { providers, host, connection } = useRuntime(hostKey)
  const all = useAllSessions()
  const sessions = useMemo(
    () => all.filter((s) => s.hostKey === hostKey && s.session.designTools).map((s) => s.session),
    [all, hostKey],
  )
  const [picked, setPicked] = useState<string>()
  const [text, setText] = useState('')
  const defaults = usePreferences((s) => hostDefaults(s.hosts, host?.hostId ?? hostKey))

  const shown = picked === NEW ? undefined : (sessions.find((s) => s.id === picked) ?? sessions[0])
  const [instanceId, setInstanceId] = useState<string>()
  const ready = readyProviders(providers)
  const agent =
    ready.find((p) => p.id === instanceId) ?? defaultAgent(providers, defaults.instanceId)
  const saved = agentDefaults(defaults, agent)
  const selectionKey = `${host?.hostId ?? hostKey}:${agent?.id ?? ''}`
  const [selection, setSelection] = useState<{
    key: string
    modeId?: string
    choice: ModelChoice
  }>()
  const [configState, setConfigState] = useState<{
    key: string
    values: Record<string, string | boolean>
  }>()
  const [commands, setCommands] = useState<SlashCommand[]>([])
  const [preview, setPreview] = useState<{ key: string; data?: AgentPreview }>()

  const modeId = selection?.key === selectionKey ? selection.modeId : saved.permissionMode
  const chosen =
    selection?.key === selectionKey
      ? selection.choice
      : { model: saved.model, effort: saved.effort }
  const choice = modelChoice(
    agent?.capabilities.models ?? [],
    agent?.capabilities.efforts ?? [],
    chosen,
  )
  const setModeId = (next: string) => setSelection({ key: selectionKey, modeId: next, choice })
  const setChoice = (next: ModelChoice) => setSelection({ key: selectionKey, modeId, choice: next })

  // The agent's slash commands, and for ACP agents the modes and settings they only reveal on start.
  useEffect(() => {
    setCommands([])
    if (!agent?.capabilities.commands || connection !== 'connected') return
    let cancelled = false
    hostRequest(hostKey, 'commands.list', { instanceId: agent.id }).then(
      (list) => !cancelled && setCommands(list),
      () => {},
    )
    return () => {
      cancelled = true
    }
  }, [hostKey, agent?.id, agent?.capabilities.commands, connection])
  useEffect(() => {
    if (!agent || agent.kind !== 'acp' || connection !== 'connected') return
    let cancelled = false
    hostRequest(hostKey, 'agents.preview', { instanceId: agent.id }).then(
      (data) => !cancelled && setPreview({ key: selectionKey, data }),
      () => {},
    )
    return () => {
      cancelled = true
    }
  }, [hostKey, agent?.id, agent?.kind, connection, selectionKey])
  const offered = preview?.key === selectionKey ? preview.data : undefined
  const configValues = configState?.key === selectionKey ? configState.values : {}
  const configOptions = (offered?.config ?? []).map((o) => ({
    ...o,
    value: configValues[o.id] ?? o.value,
  }))
  const nativeModes = agent?.capabilities.permissionModes ?? []
  const modes = nativeModes.length > 0 ? nativeModes : (offered?.modes ?? [])
  const validModeId = modes.some((m) => m.id === modeId) ? modeId : undefined
  const slashCommands = commands.length > 0 ? commands : (offered?.commands ?? [])

  const start = async (value: string, attachments: string[]) => {
    if (!agent) throw new Error('No agent is ready on this host')
    const sessionId = await createSession(hostKey, {
      instanceId: agent.id,
      projectless: true,
      permissionMode: validModeId,
      model: choice.model,
      effort: choice.effort,
      config: Object.keys(configValues).length > 0 ? configValues : undefined,
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
            disabled={connection !== 'connected' || !agent}
            busy={false}
            commands={slashCommands}
            onSend={start}
            modes={modes}
            modeId={validModeId ?? offered?.currentModeId}
            onModeChange={setModeId}
            modelSlot={
              agent && (
                <>
                  <ConfigMenu
                    options={configOptions}
                    onChange={(id, value) =>
                      setConfigState({
                        key: selectionKey,
                        values: { ...configValues, [id]: value },
                      })
                    }
                  />
                  <ModelMenu
                    models={agent.capabilities.models ?? []}
                    efforts={agent.capabilities.efforts ?? []}
                    value={choice}
                    onChange={setChoice}
                  />
                </>
              )
            }
            footer={
              <div className="footer-bar">
                <AgentChip agents={providers} current={agent} onPick={setInstanceId} />
              </div>
            }
          />
        </div>
      )}
    </aside>
  )
}
