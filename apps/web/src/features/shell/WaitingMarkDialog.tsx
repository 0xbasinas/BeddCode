import { useState } from 'react'
import { create } from 'zustand'
import { tomorrowMorning } from '@beddcode/client-runtime'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '../../ui/Select.tsx'
import { setSessionWaiting } from '../../stores/host.ts'

interface DialogState {
  sessionId: string | null
  open: (sessionId: string) => void
  close: () => void
}

const useWaitingDialog = create<DialogState>((set) => ({
  sessionId: null,
  open: (sessionId) => set({ sessionId }),
  close: () => set({ sessionId: null }),
}))

/** Opens the dialog that marks a session as waiting on the user. */
export const openWaitingDialog = (sessionId: string) => useWaitingDialog.getState().open(sessionId)

const REMINDERS: { id: string; label: string; at: () => number | undefined }[] = [
  { id: 'none', label: 'No reminder', at: () => undefined },
  { id: 'hour', label: 'In 1 hour', at: () => Date.now() + 60 * 60_000 },
  { id: 'tomorrow', label: 'Tomorrow at 10:00', at: () => tomorrowMorning() },
]

export function WaitingMarkDialog() {
  const sessionId = useWaitingDialog((s) => s.sessionId)
  const close = useWaitingDialog((s) => s.close)
  if (!sessionId) return null
  return <WaitingForm key={sessionId} sessionId={sessionId} onClose={close} />
}

function WaitingForm({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const [note, setNote] = useState('')
  const [reminder, setReminder] = useState('none')
  const [error, setError] = useState<string>()
  const save = () => {
    const remindAt = REMINDERS.find((r) => r.id === reminder)?.at()
    setSessionWaiting(sessionId, true, { note: note.trim() || undefined, remindAt }).then(
      onClose,
      (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
    )
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent aria-describedby={undefined} className="sm:max-w-sm">
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            save()
          }}
        >
          <DialogHeader>
            <DialogTitle>Mark as waiting on you</DialogTitle>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="waiting-note">Note (optional)</Label>
            <Input
              id="waiting-note"
              autoFocus
              value={note}
              maxLength={280}
              placeholder="What to come back to"
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="waiting-remind">Remind me</Label>
            <Select
              id="waiting-remind"
              className="w-full"
              value={reminder}
              onChange={(e) => setReminder(e.target.value)}
            >
              {REMINDERS.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </Select>
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit">Mark</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
