import { useState } from 'react'
import { Monitor } from 'lucide-react'
import { useHostStore } from '../../stores/host.ts'
import { LOCAL_HOST_KEY } from '../../stores/hostCatalog.ts'
import { Select } from '../../ui/Select.tsx'
import { SchedulesSettings } from '../settings/SchedulesSettings.tsx'
// The schedule list and its editor share the settings pages' cards and form controls.
import '../settings/settings.css'

/** Prompts a host runs on a timer: its own screen, in the main area beside the sidebar. */
export function SchedulesPage() {
  const entries = useHostStore((s) => s.entries)
  const runtimes = useHostStore((s) => s.runtimes)
  const [hostKey, setHostKey] = useState(LOCAL_HOST_KEY)
  const selected = entries.some((e) => e.key === hostKey) ? hostKey : LOCAL_HOST_KEY
  return (
    <main className="panel settings-main schedules-page">
      <div className="settings-content">
        <header className="settings-heading">
          <h2>Schedules</h2>
        </header>
        {entries.length > 1 && (
          <label className="settings-host">
            <Monitor size={16} />
            <span>Host</span>
            <Select
              aria-label="Schedules host"
              value={selected}
              onChange={(e) => setHostKey(e.target.value)}
            >
              {entries.map((entry) => (
                <option key={entry.key} value={entry.key}>
                  {entry.key === LOCAL_HOST_KEY
                    ? 'This PC'
                    : (runtimes[entry.key]?.host?.name ?? entry.name)}
                </option>
              ))}
            </Select>
          </label>
        )}
        <SchedulesSettings key={selected} hostKey={selected} />
      </div>
    </main>
  )
}
