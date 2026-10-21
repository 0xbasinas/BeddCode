import {
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { AppShell } from './features/shell/AppShell.tsx'
import { NewSession } from './features/newsession/NewSession.tsx'
import { ThreadView } from './features/thread/ThreadView.tsx'

const rootRoute = createRootRoute({ component: AppShell })
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  // `project` preselects a folder, e.g. from the + next to a project in the sidebar.
  validateSearch: (search: Record<string, unknown>): { project?: string } => ({
    project: typeof search.project === 'string' ? search.project : undefined,
  }),
  component: function NewSessionPage() {
    const { project } = indexRoute.useSearch()
    // Keyed so picking another project starts from fresh state.
    return <NewSession key={project ?? ''} initialProject={project} />
  },
})
const sessionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/session/$sessionId',
  component: function SessionPage() {
    const { sessionId } = sessionRoute.useParams()
    return <ThreadView sessionId={sessionId} />
  },
})

// Hash history so the Electron build works when loaded from file://.
export const router = createRouter({
  routeTree: rootRoute.addChildren([indexRoute, sessionRoute]),
  history: createHashHistory(),
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
