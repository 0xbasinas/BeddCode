export interface HostHealth {
  name: string
  version: string
  platform: string
  protocol: number
}

/** What a host on this machine's port says about itself, or null when nothing answers. */
export async function fetchHealth(
  port: number,
  fetchFn: typeof fetch = fetch,
): Promise<HostHealth | null> {
  try {
    const res = await fetchFn(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(1500),
    })
    if (!res.ok) return null
    const body = (await res.json()) as {
      ok?: boolean
      protocol?: number
      host?: { name?: string; version?: string; platform?: string }
    }
    if (!body.ok) return null
    return {
      name: body.host?.name ?? 'this host',
      version: body.host?.version ?? 'unknown',
      platform: body.host?.platform ?? 'unknown',
      protocol: body.protocol ?? 0,
    }
  } catch {
    return null
  }
}
