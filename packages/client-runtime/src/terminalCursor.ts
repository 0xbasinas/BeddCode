/** Tracks output applied to one terminal view. Offsets count JavaScript UTF-16 code units. */
export class TerminalCursor {
  private seq: number | undefined

  attach(id: string) {
    return this.seq === undefined
      ? { t: 'term.attach' as const, id }
      : { t: 'term.attach' as const, id, afterSeq: this.seq }
  }

  take(frame: {
    data: string
    seq?: number
    replay?: boolean
    truncated?: boolean
  }): { data: string; reset: boolean; truncated?: boolean } | 'gap' {
    if (frame.seq === undefined) {
      this.seq = undefined // An older host always supplies full history on attach.
      return { data: frame.data, reset: !!frame.replay }
    }
    const start = frame.seq - frame.data.length
    if (start < 0) return 'gap'
    if (frame.replay) {
      this.seq = frame.seq
      return { data: frame.data, reset: true, ...(frame.truncated ? { truncated: true } : {}) }
    }
    if (this.seq !== undefined && start > this.seq) return 'gap'
    const skip =
      this.seq === undefined ? 0 : Math.min(frame.data.length, Math.max(0, this.seq - start))
    this.seq = Math.max(this.seq ?? 0, frame.seq)
    return { data: frame.data.slice(skip), reset: false }
  }
}
