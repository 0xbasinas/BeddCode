import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  AlertSettings,
  DEFAULT_ALERT_EVENTS,
  PushRegistration,
  type AlertEvents,
  type AlertKind,
  type AlertPayload,
  type Schedule,
  type ScheduleRun,
  type SentAlert,
  type StoredEvent,
} from '@beddcode/contracts'
import type { Logger } from '@beddcode/shared'
import { digest } from './digest.ts'

export const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send'
const RECENT_KEPT = 20
/** The same alert for the same session this soon again is dropped. */
const REPEAT_MS = 3_000

type Fetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{
  ok: boolean
  status: number
  json(): Promise<unknown>
}>

export interface AlertServiceOptions {
  file: string
  log: Logger
  hostId: string
  readSession(sessionId: string): StoredEvent[]
  /** True when a schedule's run covers this session's turn; the schedule alerts instead. */
  scheduledTurn?: (sessionId: string) => boolean
  fetch?: Fetch
  now?: () => number
}

interface Stored {
  settings: AlertSettings
  devices: PushRegistration[]
}

/**
 * Decides when something deserves a phone alert (a turn finished or failed, an agent waits for
 * the user, a scheduled run ended) and sends it: Expo push to registered phones, and an ntfy topic
 * when one is set. Runs on the host, so alerts come whether or not any app is open.
 */
export class AlertService {
  private data: Stored = { settings: {}, devices: [] }
  private readonly recent: SentAlert[] = []
  private readonly last = new Map<string, number>()
  private readonly now: () => number
  private readonly fetch: Fetch

  constructor(private readonly options: AlertServiceOptions) {
    this.now = options.now ?? Date.now
    this.fetch = options.fetch ?? (globalThis.fetch as unknown as Fetch)
    this.load()
  }

  private load() {
    try {
      const raw = JSON.parse(readFileSync(this.options.file, 'utf8')) as Partial<Stored>
      const settings = AlertSettings.safeParse(raw.settings ?? {})
      this.data = {
        settings: settings.success ? settings.data : {},
        devices: (raw.devices ?? []).flatMap((d) => {
          const parsed = PushRegistration.safeParse(d)
          return parsed.success ? [parsed.data] : []
        }),
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT')
        this.options.log.warn(`could not read ${this.options.file}`, err)
    }
  }

  private save() {
    mkdirSync(path.dirname(this.options.file), { recursive: true })
    const tmp = `${this.options.file}.tmp`
    // Push tokens are not secrets that unlock anything here, but keep the file private anyway.
    writeFileSync(tmp, JSON.stringify({ version: 1, ...this.data }, null, 2), { mode: 0o600 })
    renameSync(tmp, this.options.file)
  }

  view() {
    return {
      settings: this.data.settings,
      devices: this.data.devices.map(({ token, ...rest }) => ({
        ...rest,
        tokenTail: token.replace(/\]$/, '').slice(-6),
      })),
      recent: this.recent,
    }
  }

  setSettings(patch: { ntfyUrl?: string | null; ntfyEvents?: AlertEvents }): AlertSettings {
    const next: AlertSettings = { ...this.data.settings }
    if (patch.ntfyUrl === null || patch.ntfyUrl === '') delete next.ntfyUrl
    else if (patch.ntfyUrl !== undefined) next.ntfyUrl = patch.ntfyUrl
    if (patch.ntfyEvents) next.ntfyEvents = patch.ntfyEvents
    this.data.settings = next
    this.save()
    return next
  }

  register(deviceId: string | undefined, reg: Omit<PushRegistration, 'deviceId' | 'createdAt'>) {
    const existing = this.data.devices.find((d) => d.token === reg.token)
    const entry: PushRegistration = {
      ...reg,
      deviceId,
      createdAt: existing?.createdAt ?? this.now(),
    }
    this.data.devices = [...this.data.devices.filter((d) => d.token !== reg.token), entry]
    this.save()
  }

  unregister(token: string): boolean {
    const before = this.data.devices.length
    this.data.devices = this.data.devices.filter((d) => d.token !== token)
    this.save()
    return this.data.devices.length < before
  }

  /** A revoked device gets nothing more. */
  forgetDevice(deviceId: string) {
    const before = this.data.devices.length
    this.data.devices = this.data.devices.filter((d) => d.deviceId !== deviceId)
    if (this.data.devices.length < before) this.save()
  }

  /** The alert a new event deserves, if any. */
  alertFor(stored: StoredEvent): AlertPayload | undefined {
    const { event } = stored
    let kind: AlertKind
    let body: string
    if (event.type === 'turn.completed') {
      if (event.reason === 'cancelled') return undefined
      if (this.options.scheduledTurn?.(event.sessionId)) return undefined
      kind = event.reason === 'done' ? 'turnDone' : 'error'
      body =
        event.reason === 'done'
          ? 'Finished and waiting for your next message'
          : `Stopped with an error${event.message ? `: ${event.message}` : ''}`
    } else if (event.type === 'approval.requested') {
      kind = 'needsYou'
      body = `Needs your approval: ${event.title}`
    } else if (event.type === 'question.requested') {
      kind = 'needsYou'
      body = event.questions[0]?.question ?? 'Has a question for you'
    } else {
      return undefined
    }
    const d = digest(this.options.readSession(event.sessionId))
    // A child's finished turn is its parent agent's business; the user hears from the parent.
    if (kind === 'turnDone' && d?.parentSessionId) return undefined
    if (kind === 'turnDone' && d?.lastReply) body = d.lastReply.replace(/\s+/g, ' ').slice(0, 160)
    // A child that needs the user or failed says whose helper it is, so the alert makes sense alone.
    const parent = d?.parentSessionId
      ? digest(this.options.readSession(d.parentSessionId))?.title
      : undefined
    return {
      kind,
      title: parent ? `${d?.title || 'Session'} (for ${parent})` : d?.title || 'Session',
      body,
      sessionId: event.sessionId,
      hostId: this.options.hostId,
    }
  }

  /** Follows the log: call with each new event. */
  onEvent(stored: StoredEvent) {
    const alert = this.alertFor(stored)
    if (alert) void this.send(alert)
  }

  onRunEnded(run: ScheduleRun, schedule: Schedule) {
    if (run.status === 'cancelled') return
    const reply = run.sessionId
      ? digest(this.options.readSession(run.sessionId))?.lastReply
      : undefined
    void this.send({
      kind: 'schedule',
      title: `Scheduled: ${schedule.name}`,
      body:
        run.status === 'done'
          ? (reply?.replace(/\s+/g, ' ').slice(0, 160) ?? 'Finished')
          : `Did not finish${run.note ? `: ${run.note}` : ''}`,
      sessionId: run.sessionId,
      hostId: this.options.hostId,
    })
  }

  test(): Promise<SentAlert> {
    return this.send(
      {
        kind: 'turnDone',
        title: 'BeddCode',
        body: 'Alerts from this host work.',
        hostId: this.options.hostId,
      },
      true,
    )
  }

  async send(alert: AlertPayload, force = false): Promise<SentAlert> {
    const key = `${alert.sessionId ?? ''}:${alert.kind}`
    const now = this.now()
    const sent: SentAlert = { ...alert, at: now, deliveries: [] }
    if (!force && now - (this.last.get(key) ?? 0) < REPEAT_MS) return sent
    this.last.set(key, now)

    const wants = (events: AlertEvents | undefined) =>
      force || (events ?? DEFAULT_ALERT_EVENTS)[alert.kind]
    const phones = this.data.devices.filter((d) => wants(d.events))
    const jobs: Promise<void>[] = []
    if (phones.length > 0) jobs.push(this.sendExpo(alert, phones, sent))
    if (this.data.settings.ntfyUrl && wants(this.data.settings.ntfyEvents))
      jobs.push(this.sendNtfy(alert, this.data.settings.ntfyUrl, sent))
    await Promise.all(jobs)
    this.recent.unshift(sent)
    this.recent.splice(RECENT_KEPT)
    this.options.log.info(
      `alert ${alert.kind} "${alert.title}": ${sent.deliveries.map((d) => `${d.to}=${d.ok ? 'ok' : d.error}`).join(', ') || 'nowhere to send'}`,
    )
    return sent
  }

  private async sendExpo(alert: AlertPayload, phones: PushRegistration[], sent: SentAlert) {
    const messages = phones.map((p) => ({
      to: p.token,
      title: alert.title,
      body: alert.body,
      sound: 'default',
      priority: 'high',
      channelId: 'alerts',
      data: {
        kind: alert.kind,
        sessionId: alert.sessionId,
        hostId: alert.hostId,
        url: deepLink(alert),
      },
    }))
    try {
      const res = await this.fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(messages),
      })
      const body = (await res.json().catch(() => ({}))) as {
        data?: { status: string; message?: string; details?: { error?: string } }[]
        errors?: { message: string }[]
      }
      phones.forEach((p, i) => {
        const ticket = body.data?.[i]
        const to = `expo:${p.deviceName ?? p.token.slice(-8)}`
        if (res.ok && ticket?.status === 'ok') return sent.deliveries.push({ to, ok: true })
        const error = ticket?.message ?? body.errors?.[0]?.message ?? `HTTP ${res.status}`
        sent.deliveries.push({ to, ok: false, error })
        // The app was uninstalled or the token replaced: stop sending to it.
        if (ticket?.details?.error === 'DeviceNotRegistered') this.unregister(p.token)
      })
    } catch (err) {
      for (const p of phones)
        sent.deliveries.push({
          to: `expo:${p.deviceName ?? p.token.slice(-8)}`,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        })
    }
  }

  private async sendNtfy(alert: AlertPayload, topicUrl: string, sent: SentAlert) {
    try {
      const url = new URL(topicUrl)
      const topic = url.pathname.replace(/^\/+|\/+$/g, '')
      const res = await this.fetch(`${url.origin}/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          topic,
          title: alert.title,
          message: alert.body,
          priority: alert.kind === 'needsYou' ? 4 : 3,
          tags: [
            alert.kind === 'error'
              ? 'warning'
              : alert.kind === 'needsYou'
                ? 'raising_hand'
                : 'white_check_mark',
          ],
          ...(alert.sessionId ? { click: deepLink(alert) } : {}),
        }),
      })
      sent.deliveries.push(
        res.ok ? { to: 'ntfy', ok: true } : { to: 'ntfy', ok: false, error: `HTTP ${res.status}` },
      )
    } catch (err) {
      sent.deliveries.push({
        to: 'ntfy',
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
}

/** Opens the session in the phone app. */
export const deepLink = (alert: Pick<AlertPayload, 'sessionId'>) =>
  alert.sessionId ? `beddcode://session/${alert.sessionId}` : 'beddcode://'
