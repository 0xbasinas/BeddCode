import { execFile } from 'node:child_process'
import type { Outcome, PictureRegion } from './driver.ts'

// Finds where a Windows window's password and secret fields are, through UI Automation, so a picture
// of the window can be sent with those fields painted over instead of being withheld whole.

export interface UiaField {
  type?: string
  id?: string
  name: string
  password: boolean
  x: number
  y: number
  w: number
  h: number
}

export interface UiaFields {
  win: { x: number; y: number; w: number; h: number }
  fields: UiaField[]
}

export type RunScript = (script: string) => Promise<string>

const script = (hwnd: number) => `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class Dpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
[void][Dpi]::SetProcessDPIAware()
$w = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]::new(${Math.trunc(hwnd)}))
$r = $w.Current.BoundingRectangle
$out = @()
foreach ($e in $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
  $b = $e.Current.BoundingRectangle
  if ($b.IsEmpty) { continue }
  $pw = [bool]$e.Current.IsPassword
  if (-not $pw -and -not $e.Current.Name -and -not $e.Current.AutomationId) { continue }
  $t = $e.Current.ControlType.ProgrammaticName -replace '^ControlType.', ''
  $out += [pscustomobject]@{ type = $t; id = $e.Current.AutomationId; name = $e.Current.Name; password = $pw; x = $b.X; y = $b.Y; w = $b.Width; h = $b.Height }
  if ($out.Count -ge 600) { break }
}
@{ win = @{ x = $r.X; y = $r.Y; w = $r.Width; h = $r.Height }; fields = @($out) } | ConvertTo-Json -Depth 4 -Compress
`

const powershell: RunScript = (code) =>
  new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', code],
      { timeout: 8000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    )
  })

/** Reads the window's text fields and its rectangle, in screen pixels. */
export async function readFields(
  hwnd: number,
  run: RunScript = powershell,
): Promise<Outcome<UiaFields>> {
  try {
    const parsed = JSON.parse(await run(script(hwnd))) as UiaFields
    if (!parsed?.win || !(parsed.win.w > 0) || !(parsed.win.h > 0) || !Array.isArray(parsed.fields))
      return { ok: false, code: 'error', error: 'The window reported no size' }
    return { ok: true, ...parsed }
  } catch (err) {
    return {
      ok: false,
      code: 'error',
      error: `Could not locate the secret fields: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

/** The secret fields as rectangles in the picture's pixels. */
export function regionsOf(
  found: UiaFields,
  picture: { width: number; height: number },
  isSecret: (label: string) => boolean,
  /** The window as the picture shows it, when the driver knows (UI Automation's own rectangle includes the invisible resize border). */
  frame?: { x: number; y: number; width: number; height: number },
): PictureRegion[] {
  const f0 = frame ?? { x: found.win.x, y: found.win.y, width: found.win.w, height: found.win.h }
  const sx = picture.width / f0.width
  const sy = picture.height / f0.height
  return found.fields
    .filter((f) => f.password || isSecret(`${f.type ?? 'Edit'} "${f.name}" [id=${f.id ?? ''}]`))
    .map((f) => ({
      x: (f.x - f0.x) * sx,
      y: (f.y - f0.y) * sy,
      width: f.w * sx,
      height: f.h * sy,
    }))
}
