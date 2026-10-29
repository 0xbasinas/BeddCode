import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PNG } from 'pngjs'
import { afterAll, describe, expect, it } from 'vitest'
import { ComputerTools } from './computerTools.ts'
import { CuaDesktopDriver } from './cuaDriver.ts'

// Opens a small Windows Forms window with a password box and checks that its picture comes back with
// the box painted over. Off unless BEDDCODE_REAL_COMPUTER=1 (it opens a window on the user's screen).
const on = process.platform === 'win32' && process.env.BEDDCODE_REAL_COMPUTER === '1'

const FORM = `
Add-Type -AssemblyName System.Windows.Forms
$f = New-Object System.Windows.Forms.Form
$f.Text = 'BeddCodeSecretTest'; $f.Width = 420; $f.Height = 220; $f.StartPosition = 'CenterScreen'
$l = New-Object System.Windows.Forms.Label; $l.Text = 'Account'; $l.Left = 20; $l.Top = 20; $l.Width = 80
$u = New-Object System.Windows.Forms.TextBox; $u.Left = 110; $u.Top = 18; $u.Width = 240; $u.Text = 'visible-name'
$p = New-Object System.Windows.Forms.TextBox; $p.Left = 110; $p.Top = 60; $p.Width = 240
$p.Name = 'password'; $p.UseSystemPasswordChar = $true; $p.Text = 'hunter2-secret'
$f.Controls.AddRange(@($l, $u, $p))
$f.Add_Shown({ $f.Activate() })
[void]$f.ShowDialog()
`

describe.skipIf(!on)('secret fields on the real desktop', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'computer-secret-'))
  let form: ChildProcess | undefined
  const tools = new ComputerTools(
    () => CuaDesktopDriver.load(),
    {
      currentMode: () => 'default',
      modeLevel: () => 1,
      describe: async () => ({ agent: 'Claude' }),
      askUser: async () => true,
    },
    dir,
  )

  afterAll(async () => {
    form?.kill()
    tools.revoke('secret')
    await tools.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  it('paints over the password box and keeps the rest of the picture', async () => {
    form = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', FORM], { stdio: 'ignore' })
    await new Promise((r) => setTimeout(r, 4000))
    const list = await tools.call('secret', 'computer_windows', {})
    const line = list.content
      .map((c) => (c.type === 'text' ? c.text : ''))
      .join('')
      .split('\n')
      .find((l) => l.includes('BeddCodeSecretTest'))
    expect(line, 'the form did not open').toBeDefined()
    const id = Number(line!.split('\t')[0])

    const r = await tools.call('secret', 'computer_snapshot', { window: id })
    const t = r.content.map((c) => (c.type === 'text' ? c.text : '')).join('')
    expect(t).toMatch(/painted over/)
    expect(t).not.toContain('hunter2')

    const shot = tools.viewOf('secret', true).image
    expect(shot).toBeDefined()
    if (process.env.SAVE_SHOT)
      writeFileSync(process.env.SAVE_SHOT, Buffer.from(shot!.data, 'base64'))
    const png = PNG.sync.read(Buffer.from(shot!.data, 'base64'))
    // The window is mostly the light form: the painted box is a solid black block much wider than any text.
    let longest = 0
    for (let y = 0; y < png.height; y++) {
      let run = 0
      for (let x = 0; x < png.width; x++) {
        const i = (y * png.width + x) * 4
        const black = png.data[i]! < 8 && png.data[i + 1]! < 8 && png.data[i + 2]! < 8
        run = black ? run + 1 : 0
        longest = Math.max(longest, run)
      }
    }
    expect(longest).toBeGreaterThan(png.width * 0.3)
  }, 60_000)
})
