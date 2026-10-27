/** A small client for the BeddCode host's WebSocket protocol, shared by the e2e suites. */
export type Frame = { t: string; [key: string]: any }

export class Host {
  socket!: WebSocket
  sequence = 0
  events: { seq: number; event: any }[] = []
  waiters = new Set<() => void>()
  pending = new Map<string, { resolve(value: any): void; reject(error: Error): void }>()
  requestId = 0
  constructor(readonly url: string) {}
  async connect(afterSeq = 0) {
    this.socket = new WebSocket(this.url)
    this.socket.onmessage = ({ data }) => {
      const frame: Frame = JSON.parse(String(data))
      if (frame.t === 'welcome') this.send({ t: 'subscribe', afterSeq, batch: false })
      if (frame.t === 'res') {
        const p = this.pending.get(frame.id)
        if (p) {
          this.pending.delete(frame.id)
          frame.ok ? p.resolve(frame.result) : p.reject(new Error(frame.error))
        }
      }
      const records =
        frame.t === 'event' ? [frame.stored] : frame.t === 'events' ? frame.events : []
      for (const record of records) {
        this.events.push(record)
        this.sequence = Math.max(this.sequence, record.seq)
      }
      if (frame.t === 'caught-up') this.sequence = Math.max(this.sequence, frame.seq)
      if (frame.t === 'caught-up') this.ready?.()
      for (const wake of this.waiters) wake()
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('host connection timed out')), 15_000)
      this.ready = () => {
        clearTimeout(timer)
        resolve()
      }
      this.socket.onerror = () => {
        clearTimeout(timer)
        reject(new Error('host connection failed'))
      }
      this.socket.onopen = () => this.send({ t: 'hello', protocol: 1 })
    })
  }
  private ready?: () => void
  send(frame: object) {
    this.socket.send(JSON.stringify(frame))
  }
  rpc(method: string, params: object) {
    const id = String(++this.requestId)
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out`))
      }, 60_000)
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      })
      this.send({ t: 'req', id, method, params })
    })
  }
  async wait(predicate: () => boolean, timeout = 150_000) {
    if (predicate()) return
    await new Promise<void>((resolve, reject) => {
      const check = () => {
        if (predicate()) {
          clearTimeout(timer)
          this.waiters.delete(check)
          resolve()
        }
      }
      const timer = setTimeout(() => {
        this.waiters.delete(check)
        reject(new Error('event wait timed out'))
      }, timeout)
      this.waiters.add(check)
      check()
    })
  }
  close() {
    this.socket.close()
  }
}
