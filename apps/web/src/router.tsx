import { lazy, Suspense } from 'react'
import {
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { AppShell } from './features/shell/AppShell.tsx'
import { NewSession } from './features/newsession/NewSession.tsx'
import { ThreadView } from './features/thread/ThreadView.tsx'
import { SchedulesPage } from './features/schedules/SchedulesPage.tsx'
import {
  SettingsPage,
  parseSettingsSection,
  type SettingsSection,
} from './features/settings/SettingsPage.tsx'

// The editor and its libraries are large; load them when the screen is first opened.
const DesignPage = lazy(() =>
  import('./features/design/DesignPage.tsx').then((m) => ({ default: m.DesignPage })),
)

const rootRoute = createRootRoute({ component: AppShell })
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  // `project` preselects a folder, e.g. from the + next to a project in the sidebar; `host` says
  // on which host that folder lives.
  // `compose` asks for the composer itself, even while the first-run checklist would show.
  validateSearch: (
    search: Record<string, unknown>,
  ): { project?: string; host?: string; compose?: boolean } => ({
    project: typeof search.project === 'string' ? search.project : undefined,
    host: typeof search.host === 'string' ? search.host : undefined,
    compose: search.compose === true || search.compose === 'true' ? true : undefined,
  }),
  component: function NewSessionPage() {
    const { project, host, compose } = indexRoute.useSearch()
    // Keyed so picking another project starts from fresh state.
    return (
      <NewSession
        key={`${host ?? ''}:${project ?? ''}:${compose ? 'compose' : ''}`}
        initialProject={project}
        initialHost={host}
        compose={compose}
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

const schedulesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/schedules',
  component: SchedulesPage,
})

const designRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/design',
  component: () => (
    <Suspense fallback={null}>
      <DesignPage />
    </Suspense>
  ),
})

// Hash history so the Electron build works when loaded from file://.
export const router = createRouter({
  routeTree: rootRoute.addChildren([
    indexRoute,
    sessionRoute,
    designRoute,
    schedulesRoute,
    settingsRoute,
  ]),
  history: createHashHistory(),
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
