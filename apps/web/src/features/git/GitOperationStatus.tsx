import { Check, CircleAlert, LoaderCircle, X } from 'lucide-react'
import { dismissGitOperation, pushBranch, type GitOperation } from './operations.ts'

export function GitOperationStatus({
  operation,
  hostKey,
  cwd,
}: {
  operation: GitOperation
  hostKey: string
  cwd: string
}) {
  const pendingText =
    operation.kind === 'commit-and-push'
      ? 'Committing & pushing…'
      : operation.kind === 'push'
        ? 'Pushing branch…'
        : 'Committing…'
  const completeText =
    operation.kind === 'push'
      ? 'Branch pushed.'
      : `Committed ${operation.hash?.slice(0, 7)}${operation.pushed ? ' and pushed' : ''}.`
  const Icon = operation.pending ? LoaderCircle : operation.error ? CircleAlert : Check
  return (
    <div
      className={`git-operation ${operation.error ? 'failed' : ''}`}
      role={operation.error ? 'alert' : 'status'}
    >
      <Icon size={15} className={operation.pending ? 'git-operation-spinner' : undefined} />
      <div className="git-operation-content">
        <div className="git-operation-message">
          {operation.pending ? pendingText : (operation.error ?? completeText)}
        </div>
        {!operation.pending && operation.error && (operation.hash || operation.kind === 'push') && (
          <button
            className="link-btn"
            onClick={() => void pushBranch(hostKey, cwd).catch(() => {})}
          >
            Retry push
          </button>
        )}
      </div>
      {!operation.pending && (
        <button
          className="icon-btn"
          aria-label="Dismiss Git result"
          onClick={() => dismissGitOperation(hostKey, cwd)}
        >
          <X size={13} />
        </button>
      )}
    </div>
  )
}
