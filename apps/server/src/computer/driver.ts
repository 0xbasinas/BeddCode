// Computer use: what a desktop driver has to do. ComputerTools holds the policy (what an agent may
// touch, approvals, limits); a driver only operates windows. Cua drives the real Windows desktop;
// other drivers (a virtual X display, a container) can sit behind the same interface.

export interface DesktopWindow {
  /** The id agents pass back; only meaningful to the driver that listed it. */
  id: number
  pid: number
  app: string
  title: string
  onScreen: boolean
  minimized?: boolean
  bounds?: { x: number; y: number; width: number; height: number }
}

export interface DesktopImage {
  /** Base64. */
  data: string
  mime: string
}

export type FailCode =
  /** The window belongs to a process running with more rights; Windows drops our input. */
  | 'elevated'
  /** This window does not accept this kind of input without taking the foreground. */
  | 'foreground_needed'
  /** The element ref no longer matches what the driver last read. */
  | 'stale'
  | 'unavailable'
  | 'error'

export type Outcome<T extends object = object> =
  ({ ok: true } & T) | { ok: false; code: FailCode; error: string }

export interface Snapshot {
  /** The accessibility tree, one element per line; rows an agent can act on carry "[N]". */
  text: string
  /** The element at each index as the driver described it ("Button \"Seven\" [id=num7Button]"). */
  rows: Map<number, string>
  image?: DesktopImage
}

export interface InputOptions {
  /** Take the foreground for this input (the driver puts the previous window back afterwards). */
  foreground?: boolean
}

export type ClickTarget = { index: number } | { x: number; y: number }

export interface DesktopDriver {
  readonly name: string
  /** Whether this driver can run here, and why not when it cannot. */
  ready(): Promise<Outcome>
  windows(): Promise<Outcome<{ windows: DesktopWindow[] }>>
  launch(app: string): Promise<Outcome<{ pid: number; windows: DesktopWindow[] }>>
  /** Reads a window. Indexes in the result are only good until the window is read again. */
  snapshot(window: DesktopWindow): Promise<Outcome<{ snapshot: Snapshot }>>
  click(
    window: DesktopWindow,
    target: ClickTarget,
    opts: InputOptions & { button?: 'left' | 'right' | 'middle'; count?: number },
  ): Promise<Outcome<{ detail: string }>>
  type(
    window: DesktopWindow,
    text: string,
    opts: InputOptions & { index?: number },
  ): Promise<Outcome<{ detail: string }>>
  /** A key ("enter") or a combination (["ctrl", "s"]). */
  key(
    window: DesktopWindow,
    keys: string | string[],
    opts: InputOptions,
  ): Promise<Outcome<{ detail: string }>>
  scroll(
    window: DesktopWindow,
    direction: 'up' | 'down' | 'left' | 'right',
    amount: number,
    opts: InputOptions,
  ): Promise<Outcome<{ detail: string }>>
  /** Ends a process this driver launched. */
  terminate(pid: number): Promise<Outcome>
  dispose(): Promise<void>
}
