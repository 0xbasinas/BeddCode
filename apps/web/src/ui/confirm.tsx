import { create } from 'zustand'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'

interface Pending {
  message: string
  confirmLabel: string
  resolve: (ok: boolean) => void
}

const usePending = create<{ pending: Pending | null }>(() => ({ pending: null }))

/** Asks the user to confirm; stands in for `window.confirm` with the app's own dialog. */
export function confirmDialog(message: string, confirmLabel = 'Continue'): Promise<boolean> {
  return new Promise((resolve) => {
    usePending.getState().pending?.resolve(false)
    usePending.setState({ pending: { message, confirmLabel, resolve } })
  })
}

const settle = (ok: boolean) => {
  const { pending } = usePending.getState()
  usePending.setState({ pending: null })
  pending?.resolve(ok)
}

/** Renders the dialog `confirmDialog` opens; mounted once in the app shell. */
export function ConfirmHost() {
  const pending = usePending((s) => s.pending)
  return (
    <AlertDialog open={pending !== null} onOpenChange={(o) => !o && settle(false)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Are you sure?</AlertDialogTitle>
          <AlertDialogDescription>{pending?.message}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={() => settle(true)}>
            {pending?.confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
