import { execFile } from 'node:child_process'
import type { Outcome } from './driver.ts'

export type RunWindowScript = (script: string) => Promise<string>

const powershell: RunWindowScript = (script) =>
  new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: 8_000, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(stdout.trim())),
    )
  })

const restoreScript = (hwnd: number) => `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class BeddCodeWindowRestore { [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd); [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow); [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd); [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll", SetLastError=true)] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int x, int y, int cx, int cy, uint flags); }'
$target = [IntPtr]::new(${Math.trunc(hwnd)})
if (-not [BeddCodeWindowRestore]::IsWindow($target)) { throw 'The target window no longer exists.' }
$activeBefore = [BeddCodeWindowRestore]::GetForegroundWindow()
[void][BeddCodeWindowRestore]::ShowWindowAsync($target, 4) # SW_SHOWNOACTIVATE
Start-Sleep -Milliseconds 100
if ([BeddCodeWindowRestore]::IsIconic($target)) { throw 'Windows kept the target minimized.' }
if ($activeBefore -ne [IntPtr]::Zero -and $activeBefore -ne $target) {
  if (-not [BeddCodeWindowRestore]::SetWindowPos($target, $activeBefore, 0, 0, 0, 0, 0x0013)) { throw 'Windows could not keep the restored window behind the foreground window.' }
}
if ([BeddCodeWindowRestore]::GetForegroundWindow() -ne $activeBefore) { throw 'The foreground window changed while restoring the target.' }
'Restored behind the foreground window without activating it.'
`

/** Restores one minimized window without activating it, and keeps it behind the foreground window. */
export async function restoreMinimizedWindow(
  hwnd: number,
  run: RunWindowScript = powershell,
): Promise<Outcome<{ detail: string }>> {
  if (!Number.isSafeInteger(hwnd) || hwnd <= 0)
    return { ok: false, code: 'error', error: 'The window handle is invalid.' }
  try {
    return { ok: true, detail: await run(restoreScript(hwnd)) }
  } catch (err) {
    return {
      ok: false,
      code: 'error',
      error: `Could not restore the window without activating it: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}
