import {
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { AppShell } from './features/shell/AppShell.tsx'
import { NewSession } from './features/newsession/NewSession.tsx'
import { ThreadView } from './features/thread/ThreadView.tsx'
import {
  SettingsPage,
  parseSettingsSection,
  type SettingsSection,
} from './features/settings/SettingsPage.tsx'

const rootRoute = createRootRoute({ component: AppShell })
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  // `project` preselects a folder, e.g. from the + next to a project in the sidebar; `host` says
  // on which host that folder lives.
  validateSearch: (search: Record<string, unknown>): { project?: string; host?: string } => ({
    project: typeof search.project === 'string' ? search.project : undefined,
    host: typeof search.host === 'string' ? search.host : undefined,
  }),
  component: function NewSessionPage() {
    const { project, host } = indexRoute.useSearch()
    // Keyed so picking another project starts from fresh state.
    return (
      <NewSession
        key={`${host ?? ''}:${project ?? ''}`}
        initialProject={project}
        initialHost={host}
      />
    )
  },
})
const sessionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/session/$sessionId',
  component: function SessionPage() {
    const { sessionId } = sessionRoute.useParams()
    return <ThreadView key={sessionId} sessionId={sessionId} />
  },
})

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  validateSearch: (search: Record<string, unknown>): { section?: SettingsSection } => ({
    section: parseSettingsSection(search.section),
  }),
  component: function SettingsRoute() {
    const { section } = settingsRoute.useSearch()
    return <SettingsPage section={section ?? 'general'} />
  },
})

// Hash history so the Electron build works when loaded from file://.
export const router = createRouter({
  routeTree: rootRoute.addChildren([indexRoute, sessionRoute, settingsRoute]),
  history: createHashHistory(),
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
