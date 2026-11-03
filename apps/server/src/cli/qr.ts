import qrcode from 'qrcode-generator'

/**
 * A QR code for a terminal, two modules per character (half blocks). Light modules are drawn and
 * dark ones left blank, so it reads dark-on-light in the usual dark terminal; a quiet zone of two
 * modules surrounds it, as scanners need.
 */
export function terminalQr(text: string): string {
  const qr = qrcode(0, 'L')
  qr.addData(text)
  qr.make()
  const count = qr.getModuleCount()
  const quiet = 2
  const size = count + quiet * 2
  const light = (y: number, x: number) => {
    const my = y - quiet
    const mx = x - quiet
    if (my < 0 || mx < 0 || my >= count || mx >= count) return true
    return !qr.isDark(my, mx)
  }
  const lines: string[] = []
  for (let y = 0; y < size; y += 2) {
    let line = ''
    for (let x = 0; x < size; x++) {
      const top = light(y, x)
      const bottom = y + 1 < size ? light(y + 1, x) : true
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' '
    }
    lines.push(line)
  }
  return lines.join('\n')
}
