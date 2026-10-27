import type { Page } from 'playwright-core'

/** What the desktop window is timed against: a session in the sidebar and a piece of its own prompt. */
export type Session = { id: string; marker: string }
export type Sample = { contentMs: number; paintMs: number }

export const stat = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!
  return {
    n: sorted.length,
    min: Math.round(sorted[0]!),
    median: Math.round(at(0.5)),
    p95: Math.round(at(0.95)),
    max: Math.round(sorted.at(-1)!),
  }
}

/** `content` is until the session's prompt is in the page; `paint` adds two animation frames. */
export const summarize = (samples: Sample[]) => ({
  content: stat(samples.map((s) => s.contentMs)),
  paint: stat(samples.map((s) => s.paintMs)),
})

/** Clicks a session's sidebar row and waits, inside the page, for its own prompt to be on screen. */
export const openSession = (page: Page, { id, marker }: Session) =>
  page.evaluate(
    async ({ id, marker }) => {
      const row = [...document.querySelectorAll('.session-row')].find((r) =>
        (r.getAttribute('href') ?? '').endsWith(id),
      ) as HTMLElement | undefined
      const frame = () => new Promise((resolve) => requestAnimationFrame(resolve))
      const began = performance.now()
      if (row) row.click()
      else location.hash = `#/session/${id}`
      for (;;) {
        const shown = [...document.querySelectorAll('main.thread .msg.user .plain')].some((e) =>
          e.textContent?.includes(marker),
        )
        if (shown) break
        if (performance.now() - began > 15_000) throw new Error(`${id} did not open`)
        await frame()
      }
      const contentMs = performance.now() - began
      await frame()
      await frame()
      return { contentMs, paintMs: performance.now() - began }
    },
    { id, marker },
  ) as Promise<Sample>

/** Clicks "New session" and waits for the empty composer. */
export const openComposer = async (page: Page) => {
  const button = await page
    .getByRole('button', { name: 'New session', exact: true })
    .first()
    .elementHandle()
  return page.evaluate(async (el) => {
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve))
    const began = performance.now()
    ;(el as HTMLElement).click()
    for (;;) {
      if (
        !document.querySelector('main.thread') &&
        document.querySelector('[aria-label="Message"]')
      )
        break
      if (performance.now() - began > 15_000) throw new Error('Composer did not open')
      await frame()
    }
    const contentMs = performance.now() - began
    await frame()
    await frame()
    return { contentMs, paintMs: performance.now() - began }
  }, button) as Promise<Sample>
}

/** Long tasks (more than 50 ms of blocked main thread) the page logged since the last read. */
export const takeLongTasks = (page: Page) =>
  page.evaluate(() => {
    const w = window as any
    if (!w.__long) {
      w.__long = []
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) w.__long.push(e.duration)
      }).observe({ type: 'longtask', buffered: false })
      return []
    }
    return w.__long.splice(0) as number[]
  })

/** Starts logging the time between animation frames; read it with `stopFrames`. */
export const startFrames = (page: Page) =>
  page.evaluate(() => {
    const w = window as any
    w.__frames = []
    w.__framesOn = true
    let last = performance.now()
    const tick = (now: number) => {
      if (!w.__framesOn) return
      w.__frames.push(now - last)
      last = now
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })

export const stopFrames = (page: Page) =>
  page.evaluate(() => {
    const w = window as any
    w.__framesOn = false
    return w.__frames as number[]
  })

/** A smooth window draws a frame about every 16 ms; long gaps are visible stutter. */
export const frameStats = (deltas: number[]) => ({
  frames: deltas.length,
  ...(deltas.length
    ? { median: stat(deltas).median, p95: stat(deltas).p95, max: stat(deltas).max }
    : {}),
  over50ms: deltas.filter((d) => d > 50).length,
})

/** Scrolls the biggest scrollable area around or inside `root` down and back; returns its height and time. */
export const scrollThrough = (page: Page, root: string) =>
  page.evaluate(async (selector) => {
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve))
    const start = document.querySelector(selector)
    const chain: Element[] = []
    for (let e = start; e; e = e.parentElement) chain.push(e)
    const area = [...chain, ...(start ? start.querySelectorAll('*') : [])]
      .filter((e): e is HTMLElement => e instanceof HTMLElement)
      .filter(
        (e) =>
          e.scrollHeight > e.clientHeight + 50 &&
          /(auto|scroll)/.test(getComputedStyle(e).overflowY),
      )
      .sort((a, b) => b.scrollHeight - a.scrollHeight)[0]
    if (!area) return { scrollable: false, heightPx: 0, ms: 0 }
    const began = performance.now()
    const steps = 30
    const max = area.scrollHeight - area.clientHeight
    for (let i = 0; i <= steps; i++) {
      area.scrollTop = max - (max * i) / steps
      await frame()
    }
    for (let i = 0; i <= steps; i++) {
      area.scrollTop = (max * i) / steps
      await frame()
    }
    return { scrollable: true, heightPx: area.scrollHeight, ms: performance.now() - began }
  }, root)

/** Types into the sidebar search and waits until the list shrinks; returns the time and row counts. */
export const searchSidebar = async (page: Page, query: string) => {
  await page.getByRole('button', { name: 'Search', exact: true }).first().click()
  const input = await page.getByLabel('Search sessions').elementHandle()
  const out = await page.evaluate(
    async ({ el, query }) => {
      const frame = () => new Promise((resolve) => requestAnimationFrame(resolve))
      const rows = () => document.querySelectorAll('.session-row').length
      const before = rows()
      const began = performance.now()
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(el, query)
      ;(el as HTMLElement).dispatchEvent(new Event('input', { bubbles: true }))
      let last = rows()
      let stableSince = performance.now()
      while (performance.now() - began < 10_000) {
        await frame()
        const now = rows()
        if (now !== last) {
          last = now
          stableSince = performance.now()
        } else if (performance.now() - stableSince > 150 && now !== before) break
        else if (performance.now() - began > 1500 && now === before) break
      }
      return { ms: stableSince - began, before, after: rows() }
    },
    { el: input, query },
  )
  await page
    .getByRole('button', { name: 'Close search' })
    .click()
    .catch(() => {})
  return out
}

/** What ran during frames that took over 100 ms, as reported by the browser (Chromium's long-animation-frame). */
export const takeLongFrames = (page: Page) =>
  page.evaluate(() => {
    const w = window as any
    if (!w.__loaf) {
      w.__loaf = []
      new PerformanceObserver((list) => {
        for (const e of list.getEntries() as any[]) {
          if (e.duration < 100) continue
          w.__loaf.push({
            epochMs: Math.round(performance.timeOrigin + e.startTime),
            ms: Math.round(e.duration),
            blockingMs: Math.round(e.blockingDuration),
            renderMs: Math.round(
              e.styleAndLayoutStart ? e.startTime + e.duration - e.styleAndLayoutStart : 0,
            ),
            scripts: (e.scripts as any[]).map(
              (x) =>
                `${x.invoker || x.type} ${String(x.sourceURL).split('/').pop()}:${x.sourceFunctionName || '?'} ${Math.round(x.duration)}ms`,
            ),
          })
        }
      }).observe({ type: 'long-animation-frame', buffered: false })
      return []
    }
    return w.__loaf.splice(0) as {
      epochMs: number
      ms: number
      blockingMs: number
      renderMs: number
      scripts: string[]
    }[]
  })

/** A CPU profile of the page (Chrome DevTools protocol); `stop` returns the hottest functions by self time. */
export async function profilePage(page: Page) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Profiler.enable')
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 })
  await cdp.send('Profiler.start')
  return {
    async stop(top = 12) {
      const { profile } = (await cdp.send('Profiler.stop')) as {
        profile: {
          nodes: {
            id: number
            callFrame: {
              functionName: string
              url: string
              lineNumber: number
              columnNumber: number
            }
          }[]
          samples: number[]
          timeDeltas: number[]
        }
      }
      const self = new Map<number, number>()
      profile.samples.forEach((id, i) =>
        self.set(id, (self.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0)),
      )
      const hottest = profile.nodes
        .map((n) => ({
          fn: n.callFrame.functionName || '(anonymous)',
          at: `${n.callFrame.url.split('/').pop()}:${n.callFrame.lineNumber + 1}:${n.callFrame.columnNumber + 1}`,
          selfMs: Math.round((self.get(n.id) ?? 0) / 1000),
        }))
        .filter((n) => n.selfMs > 0 && n.fn !== '(idle)' && n.fn !== '(program)')
        .sort((a, b) => b.selfMs - a.selfMs)
        .slice(0, top)
      await cdp.detach().catch(() => {})
      return { hottest, raw: profile }
    },
  }
}
