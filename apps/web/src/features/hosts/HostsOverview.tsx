import { useHostStore } from '../../stores/host.ts'
import { Button } from '@/components/ui/button'
import { LOCAL_HOST_KEY } from '../../stores/hostCatalog.ts'
import { useAppPreferences } from '../../stores/appPreferences.ts'
import { Select } from '../../ui/Select.tsx'
import { HostList } from './HostControls.tsx'
import './hosts.css'

export function HostsOverview({
  onAdd,
  onShare,
  showPreferences = true,
}: {
  onAdd(): void
  onShare(): void
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
        </div>
        <Button variant="app" className="hosts-button primary" onClick={onAdd}>
          Add host
        </Button>
      </header>
      <HostList onAdd={onAdd} />
      <div className="hosts-share-row">
        <div>
          <h3>Let another computer connect</h3>
        </div>
        <Button variant="app" className="hosts-button" onClick={onShare}>
          Share this PC
        </Button>
      </div>
      {showPreferences && entries.length > 1 && (
        <div className="hosts-preference-row">
          <label htmlFor="hosts-default-host">
            <strong>Default host</strong>
            <span>Where new sessions start.</span>
          </label>
          <Select
            id="hosts-default-host"
            aria-label="Default host"
            value={entries.some((e) => e.key === defaultHostKey) ? defaultHostKey : LOCAL_HOST_KEY}
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
      )}
    </section>
  )
}
