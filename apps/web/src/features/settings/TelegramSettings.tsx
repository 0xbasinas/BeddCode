import { useCallback, useEffect, useState } from 'react'
import { Send } from 'lucide-react'
import type { RpcParams, RpcResult } from '@beddcode/contracts'
import { hostRequest, useRuntime } from '../../stores/host.ts'

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

type Status = RpcResult<'telegram.status'>

/**
 * A Telegram bot the host runs, so the user can start agents, message them and answer their
 * approvals from a chat. Only chats that send the one-time pairing code can use it.
 */
export function TelegramSettings({ hostKey }: { hostKey: string }) {
  const { connection, epoch } = useRuntime(hostKey)
  const online = connection === 'connected'
  const [status, setStatus] = useState<Status>()
  const [token, setToken] = useState('')
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    if (!online) return
    try {
      setStatus(await hostRequest(hostKey, 'telegram.status', {}))
    } catch (err) {
      setError(errorMessage(err))
    }
  }, [hostKey, online])

  useEffect(() => {
    void load()
  }, [load, epoch])

  // The bot connects a moment after the token is saved.
  useEffect(() => {
    if (!online || status?.connected || !status) return
    const timer = setInterval(() => void load(), 3_000)
    return () => clearInterval(timer)
  }, [online, status, load])

  const configure = async (params: RpcParams<'telegram.configure'>) => {
    setBusy(true)
    setError(undefined)
    try {
      setStatus(await hostRequest(hostKey, 'telegram.configure', params))
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
      <div className="settings-section-head">
        <h3>Telegram</h3>
      </div>
      <div className="settings-card">
        <form
          className="setting-row"
          onSubmit={(e) => {
            e.preventDefault()
            void configure({ token: token.trim() || null }).then(() => setToken(''))
          }}
        >
          <label className="setting-label" htmlFor="telegram-token">
            <span>Bot token</span>
            <small>
              Message @BotFather in Telegram, create a bot, and paste its token here. It is kept on
              this host only.
              {status?.botName && ` Running as @${status.botName}.`}
            </small>
          </label>
          <input
            id="telegram-token"
            className="settings-input"
            type="password"
            autoComplete="off"
            placeholder={status?.connected ? 'Token saved' : '123456:ABC…'}
            value={token}
            disabled={!online}
            onChange={(e) => setToken(e.target.value)}
          />
          <button className="settings-button" disabled={!online || busy || token.trim() === ''}>
            Save
          </button>
          {(status?.connected || status?.botName) && (
            <button
              type="button"
              className="settings-button"
              disabled={!online || busy}
              onClick={() => void configure({ token: null })}
            >
              Remove
            </button>
          )}
        </form>
        <div className="setting-row">
          <Send size={18} />
          <div className="setting-label">
            <span>
              {status?.chats
                ? `${status.chats} paired chat${status.chats === 1 ? '' : 's'}`
                : 'No chat paired'}
            </span>
            <small>
              {status?.pairCode
                ? `Send your bot: /pair ${status.pairCode} (valid for 10 minutes)`
                : 'Create a code, then send it to your bot as /pair <code>.'}
            </small>
          </div>
          <button
            className="settings-button"
            disabled={!online || busy || !status?.connected}
            onClick={() => void configure({ newPairCode: true })}
          >
            New code
          </button>
          {!!status?.chats && (
            <button
              className="settings-button"
              disabled={!online || busy}
              onClick={() => void configure({ unpair: true })}
            >
              Unpair all
            </button>
          )}
        </div>
      </div>
    </>
  )
}
