// Pure helpers for browserAgent.ts, free of Electron so they can be tested on their own.

/** A key press as Chrome DevTools Protocol's Input.dispatchKeyEvent wants it. */
export interface CdpKey {
  key: string
  code: string
  keyCode: number
  text?: string
  modifiers: number
}

const MODIFIERS: Record<string, number> = {
  alt: 1,
  option: 1,
  control: 2,
  ctrl: 2,
  meta: 4,
  cmd: 4,
  command: 4,
  super: 4,
  shift: 8,
}

const NAMED: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  return: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  left: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  up: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  right: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  down: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  insert: { key: 'Insert', code: 'Insert', keyCode: 45 },
}
for (let i = 1; i <= 12; i++) NAMED[`f${i}`] = { key: `F${i}`, code: `F${i}`, keyCode: 111 + i }

const PUNCTUATION: Record<string, [string, number]> = {
  '-': ['Minus', 189],
  '=': ['Equal', 187],
  '[': ['BracketLeft', 219],
  ']': ['BracketRight', 221],
  ';': ['Semicolon', 186],
  "'": ['Quote', 222],
  ',': ['Comma', 188],
  '.': ['Period', 190],
  '/': ['Slash', 191],
  '\\': ['Backslash', 220],
  '`': ['Backquote', 192],
}

/**
 * Parses a key like "Enter", "Control+a", "Shift+Tab" or "Meta+Shift+K". Returns null for
 * something that is not one key.
 */
export function parseKey(spec: string): CdpKey | null {
  const parts = spec.trim() === '+' ? ['+'] : spec.split('+').map((p) => p.trim())
  if (parts.some((p) => p === '')) {
    // "Control++" means Control and the plus key.
    if (spec.endsWith('++')) parts.splice(parts.length - 2, 2, '+')
    else return null
  }
  const name = parts.pop()!
  let modifiers = 0
  for (const m of parts) {
    const bit = MODIFIERS[m.toLowerCase()]
    if (!bit) return null
    modifiers |= bit
  }
  const named = NAMED[name.toLowerCase()]
  if (named) {
    const text = modifiers & ~8 ? undefined : named.text
    return { key: named.key, code: named.code, keyCode: named.keyCode, text, modifiers }
  }
  if ([...name].length !== 1) return null
  const shifted = (modifiers & 8) !== 0
  let key = name
  if (/^[a-z]$/i.test(name)) key = shifted ? name.toUpperCase() : name
  let code: string
  let keyCode: number
  if (/^[a-z]$/i.test(name)) {
    code = `Key${name.toUpperCase()}`
    keyCode = name.toUpperCase().charCodeAt(0)
  } else if (/^\d$/.test(name)) {
    code = `Digit${name}`
    keyCode = name.charCodeAt(0)
  } else if (PUNCTUATION[name]) {
    ;[code, keyCode] = PUNCTUATION[name]!
  } else {
    code = ''
    keyCode = 0
  }
  // With Control, Alt or Meta held the key is a shortcut, not text.
  const text = modifiers & ~8 ? undefined : key
  return { key, code, keyCode, text, modifiers }
}

/**
 * Wraps an agent's JavaScript (an expression, a function, or statements with `return`) so the
 * page evaluates it and answers JSON text.
 */
export function evaluateSource(script: string): string {
  const body = /(^|[^.\w$])return\b/.test(script) ? script : `return (${script}\n)`
  return `(async () => {
  let value = await (async () => {
${body}
  })()
  if (typeof value === 'function') value = await value()
  if (value === undefined) return 'undefined'
  try {
    const seen = new WeakSet()
    return JSON.stringify(value, (k, v) => {
      if (typeof v === 'bigint') return v.toString()
      if (typeof Element !== 'undefined' && v instanceof Element) return '<' + v.tagName.toLowerCase() + (v.id ? '#' + v.id : '') + '>'
      if (typeof v === 'object' && v !== null) {
        if (seen.has(v)) return '[circular]'
        seen.add(v)
      }
      return v
    }, 2) ?? String(value)
  } catch (e) {
    return String(value)
  }
})()`
}

/** Text cut to `max` characters, saying so. */
export function cap(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… (cut at ${max} characters)`
}
