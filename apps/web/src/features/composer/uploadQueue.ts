/** Bound uploads independently for each host. Removed waiting jobs never start. */
export class UploadQueue {
  private active = new Map<string, number>()
  private waiting: { host: string; run(): Promise<void>; cancelled(): boolean; resolve(): void }[] =
    []

  constructor(private readonly limit = 3) {}

  add(host: string, run: () => Promise<void>, cancelled: () => boolean): Promise<void> {
    return new Promise((resolve) => {
      this.waiting.push({ host, run, cancelled, resolve })
      this.pump()
    })
  }

  private pump() {
    for (let i = 0; i < this.waiting.length;) {
      const job = this.waiting[i]!
      if (job.cancelled()) {
        this.waiting.splice(i, 1)
        job.resolve()
      } else if ((this.active.get(job.host) ?? 0) < this.limit) {
        this.waiting.splice(i, 1)
        this.active.set(job.host, (this.active.get(job.host) ?? 0) + 1)
        void job
          .run()
          .catch(() => {})
          .finally(() => {
            this.active.set(job.host, (this.active.get(job.host) ?? 1) - 1)
            job.resolve()
            this.pump()
          })
      } else i++
    }
  }
}
