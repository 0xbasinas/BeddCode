import { z } from 'zod'

/** A design document kept on a host: a canvas the user edits and agents draw on. */
export const DesignSummary = z.object({
  id: z.string(),
  name: z.string(),
  /** Counts saves; a client that knows the latest one needs no refetch. */
  rev: z.number().int(),
  updatedAt: z.number().int(),
})
export type DesignSummary = z.infer<typeof DesignSummary>

/** The editor's own project shape (pages of elements, styles, guides); the host stores it as is. */
export const DesignProject = z.record(z.string(), z.unknown())
export type DesignProject = z.infer<typeof DesignProject>

export const Design = DesignSummary.extend({ project: DesignProject })
export type Design = z.infer<typeof Design>
