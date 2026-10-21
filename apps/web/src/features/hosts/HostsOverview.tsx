import { ChevronRight, ShieldCheck } from 'lucide-react'
import { useHostStore } from '../../stores/host.ts'
import { LOCAL_HOST_KEY } from '../../stores/hostCatalog.ts'
import { useAppPreferences } from '../../stores/appPreferences.ts'
import { Select } from '../../ui/Select.tsx'
import { HostList, HostNote } from './HostControls.tsx'
import './hosts.css'

export function HostsOverview({
  onAdd,
  onShare,
  onDevices,
  showPreferences = true,
}: {
  onAdd(): void
  onShare(): void
  onDevices(): void
  showPreferences?: boolean
}) {
  const entries = useHostStore((s) => s.entries)
  const runtimes = useHostStore((s) => s.runtimes)
  const defaultHostKey = useAppPreferences((s) => s.values.defaultHostKey)
  const updatePreferences = useAppPreferences((s) => s.update)
  return (
    <section className="hosts-overview">
      <header className="hosts-overview-heading">
        <div>
          <h2>Hosts</h2>
          <p>Run agents on your computers, wherever they are.</p>
        </div>
        <button className="hosts-button primary" onClick={onAdd}>
          Add host
        </button>
      </header>
      <div className="hosts-overview-list">
        <h3>Your computers</h3>
        <HostList onAdd={onAdd} />
        <HostNote>Sessions keep running on their host when you close the app.</HostNote>
      </div>
      <div className="hosts-share-row">
        <div>
          <h3>Let another computer connect</h3>
          <p>Create a one-time pairing code for this PC.</p>
        </div>
        <button className="hosts-button" onClick={onShare}>
          Show code
        </button>
      </div>
      <button className="hosts-devices-row" onClick={onDevices}>
        <span>
          <strong>Devices with access</strong>
          <span>See paired devices or revoke their access to this PC.</span>
        </span>
        <ChevronRight size={18} />
      </button>
      <HostNote icon={<ShieldCheck size={16} />}>
        Hosts use Tailscale or another reachable network. Each remote device must pair.
      </HostNote>
      {showPreferences && (
        <details className="hosts-preferences">
          <summary>Connection preferences</summary>
          <div className="hosts-preference-row">
            <label htmlFor="hosts-default-host">
              <strong>Default host</strong>
              <span>Where new sessions start.</span>
            </label>
            <Select
              id="hosts-default-host"
              aria-label="Default host"
              value={
                entries.some((e) => e.key === defaultHostKey) ? defaultHostKey : LOCAL_HOST_KEY
              }
              onChange={(event) => updatePreferences({ defaultHostKey: event.target.value })}
            >
              {entries.map((entry) => (
                <option key={entry.key} value={entry.key}>
                  {entry.key === LOCAL_HOST_KEY
                    ? 'This PC'
                    : (runtimes[entry.key]?.host?.name ?? entry.name)}
                </option>
              ))}
            </Select>
          </div>
          <div className="hosts-preference-row">
            <span>
              <strong>Reconnect on launch</strong>
              <span>BeddCode reconnects to every saved host automatically.</span>
            </span>
            <span>Always on</span>
          </div>
        </details>
      )}
    </section>
  )
}
