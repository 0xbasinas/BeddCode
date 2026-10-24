// The part of browser use that runs inside the page, in an isolated JavaScript world of its own
// (the page's scripts cannot see or change it; the DOM is shared). It names what is on the page
// for the agent (an accessibility-tree-like snapshot) and gives each control a ref ("e7") that
// later actions use. Plain JavaScript in a string: it is sent to the page as is.

/** The isolated world browser use runs in (any number apps do not otherwise use). */
export const AGENT_WORLD = 1045

const PRELUDE = String.raw`
var bc = globalThis.__bcAgent
if (!bc) {
  bc = globalThis.__bcAgent = { refs: new Map(), ids: new WeakMap(), next: 1 }

  var clean = function (s, max) {
    s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim()
    max = max || 120
    return s.length > max ? s.slice(0, max - 1) + '…' : s
  }
  var quote = function (s) { return JSON.stringify(s) }

  var INPUT_ROLES = { checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton',
    search: 'searchbox', submit: 'button', button: 'button', reset: 'button', image: 'button',
    color: 'button', file: 'button' }
  var CONTROL_ROLES = { link: 1, button: 1, checkbox: 1, radio: 1, textbox: 1, searchbox: 1,
    combobox: 1, listbox: 1, slider: 1, spinbutton: 1, switch: 1, tab: 1, menuitem: 1,
    menuitemcheckbox: 1, menuitemradio: 1, option: 1, treeitem: 1, clickable: 1 }
  // Shown on one line, without their content as separate lines (it is their name).
  var LEAF_ROLES = { link: 1, button: 1, checkbox: 1, radio: 1, textbox: 1, searchbox: 1,
    combobox: 1, slider: 1, spinbutton: 1, switch: 1, tab: 1, menuitem: 1, menuitemcheckbox: 1,
    menuitemradio: 1, option: 1, treeitem: 1, heading: 1, img: 1, progressbar: 1, meter: 1,
    clickable: 1, iframe: 1 }
  var SIGNIFICANT = 'a[href],button,input,select,textarea,[role],[contenteditable],h1,h2,h3,h4,h5,h6,' +
    'img,svg[aria-label],ul,ol,table,form,nav,main,header,footer,aside,dialog,label,details,summary,' +
    'iframe,video,audio,[tabindex],[onclick],fieldset,progress,meter'
  var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, HEAD: 1, META: 1, LINK: 1 }

  bc.role = function (el) {
    var explicit = (el.getAttribute('role') || '').trim().split(/\s+/)[0]
    if (explicit && explicit !== 'presentation' && explicit !== 'none' && explicit !== 'generic')
      return explicit
    var tag = el.tagName
    switch (tag) {
      case 'A': return el.hasAttribute('href') ? 'link' : ''
      case 'BUTTON': return 'button'
      case 'SUMMARY': return 'button'
      case 'INPUT': {
        var type = (el.getAttribute('type') || 'text').toLowerCase()
        if (type === 'hidden') return 'hidden'
        if (type === 'checkbox' && el.getAttribute('role') === 'switch') return 'switch'
        return INPUT_ROLES[type] || 'textbox'
      }
      case 'SELECT': return el.multiple || el.size > 1 ? 'listbox' : 'combobox'
      case 'TEXTAREA': return 'textbox'
      case 'OPTION': return 'option'
      case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6': return 'heading'
      case 'IMG': return el.getAttribute('alt') === '' ? '' : 'img'
      case 'NAV': return 'navigation'
      case 'MAIN': return 'main'
      case 'HEADER': return el.closest('article,section,aside,main,nav') ? '' : 'banner'
      case 'FOOTER': return el.closest('article,section,aside,main,nav') ? '' : 'contentinfo'
      case 'ASIDE': return 'complementary'
      case 'FORM': return 'form'
      case 'UL': case 'OL': case 'MENU': return 'list'
      case 'LI': return 'listitem'
      case 'TABLE': return 'table'
      case 'TR': return 'row'
      case 'TD': return 'cell'
      case 'TH': return 'columnheader'
      case 'DIALOG': return 'dialog'
      case 'FIELDSET': return 'group'
      case 'DETAILS': return 'group'
      case 'ARTICLE': return 'article'
      case 'SECTION': return el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby') ? 'region' : ''
      case 'PROGRESS': return 'progressbar'
      case 'METER': return 'meter'
      case 'IFRAME': return 'iframe'
      case 'VIDEO': return 'video'
      case 'AUDIO': return 'audio'
    }
    if (el.isContentEditable && (!el.parentElement || !el.parentElement.isContentEditable)) return 'textbox'
    if (el.hasAttribute('onclick') || (el.tabIndex >= 0 && el.hasAttribute('tabindex'))) return 'clickable'
    try {
      if (getComputedStyle(el).cursor === 'pointer' && el.parentElement &&
          getComputedStyle(el.parentElement).cursor !== 'pointer') return 'clickable'
    } catch (e) {}
    return ''
  }

  var textOf = function (el) {
    var t = el.innerText
    if (t == null) t = el.textContent
    return clean(t, 200)
  }
  var byIds = function (el, attr) {
    var ids = (el.getAttribute(attr) || '').trim()
    if (!ids) return ''
    var root = el.getRootNode()
    return clean(ids.split(/\s+/).map(function (id) {
      var n = root.getElementById ? root.getElementById(id) : document.getElementById(id)
      return n ? textOf(n) : ''
    }).join(' '))
  }
  var labelText = function (el) {
    var parts = []
    if (el.labels) {
      for (var i = 0; i < el.labels.length; i++) {
        var clone = el.labels[i].cloneNode(true)
        clone.querySelectorAll('input,select,textarea').forEach(function (c) { c.remove() })
        parts.push(clone.textContent)
      }
    }
    return clean(parts.join(' '))
  }

  bc.name = function (el, role) {
    var n = byIds(el, 'aria-labelledby') || clean(el.getAttribute('aria-label'))
    if (n) return n
    var tag = el.tagName
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
      var type = (el.getAttribute('type') || '').toLowerCase()
      if (type === 'submit' || type === 'button' || type === 'reset')
        return clean(el.value || (type === 'submit' ? 'Submit' : type === 'reset' ? 'Reset' : ''))
      if (type === 'image') return clean(el.alt || el.value || 'Submit')
      return labelText(el) || clean(el.getAttribute('placeholder')) || clean(el.title)
    }
    if (tag === 'IMG') return clean(el.alt || el.title)
    if (role === 'iframe') return clean(el.title || el.name)
    if (LEAF_ROLES[role] || role === 'listitem' || role === 'cell' || role === 'columnheader' ||
        role === 'row') {
      var t = textOf(el)
      if (t) return t
      var img = el.querySelector('img[alt]:not([alt=""]),svg title,[aria-label]')
      if (img) return clean(img.getAttribute('alt') || img.getAttribute('aria-label') || img.textContent)
      return clean(el.title)
    }
    if (role === 'dialog' || role === 'region' || role === 'form' || role === 'group' ||
        role === 'navigation') {
      var legend = tag === 'FIELDSET' ? el.querySelector(':scope > legend') : null
      return legend ? textOf(legend) : clean(el.title)
    }
    return ''
  }

  var visible = function (el) {
    if (el.getAttribute('aria-hidden') === 'true') return false
    if (el.checkVisibility) {
      if (!el.checkVisibility({ visibilityProperty: true })) {
        // A control hidden behind its styled label is still usable through the label.
        var ctl = el.tagName === 'INPUT' && el.labels && el.labels.length
        if (!ctl) return false
        var st = getComputedStyle(el)
        if (st.display === 'none') return false
      }
      return true
    }
    var s = getComputedStyle(el)
    return s.display !== 'none' && s.visibility !== 'hidden'
  }

  bc.refFor = function (el) {
    var id = bc.ids.get(el)
    if (!id) {
      id = 'e' + bc.next++
      bc.ids.set(el, id)
    }
    bc.refs.set(id, new WeakRef(el))
    return id
  }

  var shortHref = function (el) {
    var href = el.getAttribute('href') || ''
    try {
      var u = new URL(href, location.href)
      if (u.protocol === 'javascript:') return ''
      return u.origin === location.origin ? u.pathname + u.search + u.hash : u.href
    } catch (e) { return clean(href, 80) }
  }

  bc.describe = function (el) {
    var role = bc.role(el) || el.tagName.toLowerCase()
    var name = bc.name(el, role) || clean(el.textContent, 60)
    return role + (name ? ' ' + quote(clean(name, 60)) : '')
  }

  var children = function (el) {
    if (el.shadowRoot) return el.shadowRoot.childNodes
    if (el.tagName === 'SLOT') {
      var assigned = el.assignedNodes({ flatten: true })
      return assigned.length ? assigned : el.childNodes
    }
    return el.childNodes
  }
  var hasSignificant = function (el) {
    if (el.shadowRoot) return true
    return !!el.querySelector(SIGNIFICANT)
  }

  bc.snapshot = function (maxChars) {
    maxChars = maxChars || 40000
    var lines = []
    var size = 0
    var full = false
    var push = function (depth, line) {
      if (full) return
      var s = '  '.repeat(Math.min(depth, 20)) + '- ' + line
      size += s.length + 1
      if (size > maxChars) { full = true; return }
      lines.push(s)
    }
    var labelled = function (label) {
      var c = label.control
      return c && !label.contains(c)
    }
    var walk = function (node, depth) {
      if (full) return
      if (node.nodeType === 3) {
        var t = clean(node.textContent, 300)
        if (t) push(depth, 'text: ' + quote(t))
        return
      }
      if (node.nodeType !== 1 && node.nodeType !== 11) return
      if (node.nodeType === 11) { walkKids(node.childNodes, depth); return }
      var el = node
      if (SKIP_TAGS[el.tagName]) return
      if (!visible(el)) return
      var role = bc.role(el)
      if (role === 'hidden') return
      if (el.tagName === 'LABEL' && labelled(el)) return
      if (el.tagName === 'LEGEND' && el.parentElement && el.parentElement.tagName === 'FIELDSET') return
      if (!role) {
        // Plain text containers become one line of text.
        if (!hasSignificant(el)) {
          var text = textOf(el)
          if (text) push(depth, 'text: ' + quote(clean(text, 300)))
          return
        }
        walkKids(children(el), depth)
        return
      }
      var name = bc.name(el, role)
      var line = role === 'clickable' ? 'clickable' : role
      if (name) line += ' ' + quote(name)
      var interactive = CONTROL_ROLES[role] || el.isContentEditable
      if (interactive) line += ' [ref=' + bc.refFor(el) + ']'
      var states = []
      if (role === 'heading') states.push('level=' + (el.getAttribute('aria-level') || el.tagName.slice(1)))
      if (role === 'checkbox' || role === 'radio' || role === 'switch' || role === 'menuitemcheckbox') {
        var checked = el.tagName === 'INPUT' ? el.checked : el.getAttribute('aria-checked') === 'true'
        states.push(checked ? 'checked' : 'unchecked')
      }
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') states.push('disabled')
      if (el.getAttribute('aria-expanded')) states.push('expanded=' + el.getAttribute('aria-expanded'))
      if (el.getAttribute('aria-selected') === 'true' || (role === 'option' && el.selected)) states.push('selected')
      if (el.getAttribute('aria-pressed')) states.push('pressed=' + el.getAttribute('aria-pressed'))
      if (el.required || el.getAttribute('aria-required') === 'true') states.push('required')
      if (el.readOnly) states.push('readonly')
      if (el.getAttribute('aria-invalid') === 'true') states.push('invalid')
      if (document.activeElement === el) states.push('focused')
      if (states.length) line += ' [' + states.join(', ') + ']'
      if (role === 'textbox' || role === 'searchbox' || role === 'spinbutton' || role === 'slider') {
        var value = el.isContentEditable && el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA'
          ? el.innerText : el.value
        if (el.type === 'password' && value) value = '•'.repeat(Math.min(value.length, 12))
        if (value) line += ' value=' + quote(clean(value, 200))
        else if (el.placeholder && el.placeholder !== name) line += ' placeholder=' + quote(clean(el.placeholder))
      }
      if (el.tagName === 'SELECT') {
        var opts = Array.prototype.slice.call(el.options)
        var chosen = opts.filter(function (o) { return o.selected }).map(function (o) { return clean(o.label || o.text) })
        line += ' value=' + quote(chosen.join(', '))
        line += ' options=' + quote(opts.slice(0, 30).map(function (o) { return clean(o.label || o.text, 40) }).join(' | ') +
          (opts.length > 30 ? ' | … ' + (opts.length - 30) + ' more' : ''))
      }
      if (role === 'link') {
        var href = shortHref(el)
        if (href) line += ' href=' + quote(clean(href, 120))
      }
      if (role === 'progressbar' || role === 'meter') {
        if (el.value != null && el.max) line += ' value=' + el.value + '/' + el.max
      }
      if (LEAF_ROLES[role]) { push(depth, line); return }
      var kids = children(el)
      push(depth, line + (kids.length ? ':' : ''))
      walkKids(kids, depth + 1)
    }
    var walkKids = function (list, depth) {
      for (var i = 0; i < list.length && !full; i++) walk(list[i], depth)
    }
    // Refs of elements that left the page go.
    bc.refs.forEach(function (ref, id) {
      var el = ref.deref()
      if (!el || !el.isConnected) bc.refs.delete(id)
    })
    var dialog = document.querySelector('dialog[open]:modal')
    if (dialog) push(0, 'note: a modal dialog is open; only it can be used')
    walk(document.body || document.documentElement, 0)
    var out = lines.join('\n')
    if (full) out += '\n- note: the page is larger than this snapshot; scroll or use browser_wait_for/evaluate to look further'
    return out
  }

  bc.el = function (ref) {
    var r = bc.refs.get(String(ref || '').replace(/^@/, '').replace(/^ref=/, ''))
    var el = r && r.deref()
    if (!r) throw new Error('No element ' + ref + ' in the latest snapshot. Take a new browser_snapshot.')
    if (!el || !el.isConnected) throw new Error(ref + ' is no longer on the page. Take a new browser_snapshot.')
    return el
  }

  var deepAt = function (x, y) {
    var hit = document.elementFromPoint(x, y)
    while (hit && hit.shadowRoot) {
      var inner = hit.shadowRoot.elementFromPoint(x, y)
      if (!inner || inner === hit) break
      hit = inner
    }
    return hit
  }
  var related = function (el, hit) {
    if (!hit) return false
    if (hit === el || el.contains(hit) || (hit.contains && hit.contains(el) && hit !== document.body)) return true
    var host = hit.getRootNode && hit.getRootNode().host
    if (host && (host === el || el.contains(host))) return true
    var label = hit.closest && hit.closest('label')
    return !!(label && label.control === el)
  }

  /** Scrolls the element into view and gives the point to click, or why it cannot be clicked. */
  bc.point = function (ref) {
    var el = bc.el(ref)
    if (el.disabled) throw new Error(bc.describe(el) + ' is disabled.')
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
    var target = el
    var rect = el.getBoundingClientRect()
    if ((rect.width < 2 || rect.height < 2) && el.labels && el.labels.length) {
      target = el.labels[0]
      target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
      rect = target.getBoundingClientRect()
    }
    if (rect.width === 0 && rect.height === 0) throw new Error(bc.describe(el) + ' has no size on the page (hidden).')
    var x = rect.left + Math.min(rect.width / 2, Math.max(1, rect.width - 1))
    var y = rect.top + Math.min(rect.height / 2, Math.max(1, rect.height - 1))
    x = Math.max(1, Math.min(innerWidth - 2, x))
    y = Math.max(1, Math.min(innerHeight - 2, y))
    var hit = deepAt(x, y)
    var covered = related(target, hit) || related(el, hit) ? '' : (hit ? bc.describe(hit) : 'nothing')
    return { x: x, y: y, covered: covered, what: bc.describe(el) }
  }

  /** What an action on the element would do, for asking before a form is sent. */
  bc.info = function (ref, action) {
    var el = ref ? bc.el(ref) : document.activeElement
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement
    if (!el) return { what: 'the page', submits: false, form: '' }
    var tag = el.tagName
    var type = (el.getAttribute('type') || '').toLowerCase()
    var form = el.form || el.closest('form')
    var submits = false
    if (action === 'click') {
      if (tag === 'BUTTON') submits = !!form && (type === '' || type === 'submit')
      else if (tag === 'INPUT') submits = !!form && (type === 'submit' || type === 'image')
    } else if (action === 'enter') {
      submits = !!form && tag === 'INPUT' && !/^(button|checkbox|radio|file|reset)$/.test(type)
    }
    return { what: bc.describe(el), submits: submits,
      form: form ? clean(form.getAttribute('aria-label') || form.getAttribute('name') || form.id || form.action || '', 80) : '' }
  }

  bc.focus = function (ref, clear) {
    var el = bc.el(ref)
    if (el.disabled) throw new Error(bc.describe(el) + ' is disabled.')
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
    var editable = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable
    if (!editable) throw new Error(bc.describe(el) + ' cannot be typed into.')
    if (el.readOnly) throw new Error(bc.describe(el) + ' is read-only.')
    el.focus()
    if (clear) {
      if (el.isContentEditable && el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') {
        var range = document.createRange()
        range.selectNodeContents(el)
        var sel = getSelection()
        sel.removeAllRanges()
        sel.addRange(range)
      } else {
        try { el.select() } catch (e) {}
      }
    } else if (el.setSelectionRange && /^(text|search|url|tel|password|)$/.test(el.type || '') ) {
      try { el.setSelectionRange(el.value.length, el.value.length) } catch (e) {}
    }
    var active = document.activeElement
    while (active && active.shadowRoot && active.shadowRoot.activeElement) active = active.shadowRoot.activeElement
    return { focused: active === el, what: bc.describe(el), hasValue: !!(el.value || (el.isContentEditable && el.innerText.trim())) }
  }

  bc.value = function (ref) {
    var el = bc.el(ref)
    var v = el.isContentEditable && el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA' ? el.innerText : el.value
    if (el.type === 'password') return v ? '•'.repeat(Math.min(v.length, 12)) : ''
    return clean(v, 200)
  }

  bc.select = function (ref, values) {
    var el = bc.el(ref)
    if (el.tagName !== 'SELECT') throw new Error(bc.describe(el) + ' is not a select box; click it and pick an option instead.')
    if (el.disabled) throw new Error(bc.describe(el) + ' is disabled.')
    var opts = Array.prototype.slice.call(el.options)
    var picked = values.map(function (v) {
      var want = String(v)
      var o = opts.find(function (o) { return o.value === want }) ||
        opts.find(function (o) { return clean(o.label || o.text) === clean(want) }) ||
        opts.find(function (o) { return clean(o.label || o.text).toLowerCase() === clean(want).toLowerCase() })
      if (!o) throw new Error('No option ' + quote(want) + ' in ' + bc.describe(el) + '. Options: ' +
        opts.map(function (o) { return quote(clean(o.label || o.text, 40)) }).join(', '))
      return o
    })
    if (!el.multiple && picked.length > 1) throw new Error(bc.describe(el) + ' takes one option.')
    el.focus()
    opts.forEach(function (o) { o.selected = picked.indexOf(o) >= 0 })
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return { what: bc.describe(el), selected: picked.map(function (o) { return clean(o.label || o.text) }) }
  }

  bc.scrollBy = function (ref, dx, dy) {
    var el = ref ? bc.el(ref) : null
    if (el && !dx && !dy) {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
      return 'Scrolled ' + bc.describe(el) + ' into view.'
    }
    var target = el || document.scrollingElement || document.documentElement
    var before = [target.scrollLeft, target.scrollTop, scrollX, scrollY]
    if (el) el.scrollBy({ left: dx, top: dy, behavior: 'instant' })
    else window.scrollBy({ left: dx, top: dy, behavior: 'instant' })
    var moved = before[0] !== target.scrollLeft || before[1] !== target.scrollTop ||
      before[2] !== scrollX || before[3] !== scrollY
    var where = 'page is at ' + Math.round(scrollY) + ' of ' +
      Math.max(0, Math.round((document.scrollingElement || document.documentElement).scrollHeight - innerHeight)) + 'px'
    return (moved ? 'Scrolled' : 'Could not scroll further') + (el ? ' in ' + bc.describe(el) : '') + '; ' + where + '.'
  }

  bc.check = function (cond) {
    var body = document.body ? document.body.innerText : ''
    if (cond.text != null && body.indexOf(cond.text) < 0) return false
    if (cond.textGone != null && body.indexOf(cond.textGone) >= 0) return false
    if (cond.selector) {
      var el
      try { el = document.querySelector(cond.selector) } catch (e) { throw new Error('Bad selector: ' + cond.selector) }
      if (!el || !visible(el)) return false
    }
    return document.readyState !== 'loading'
  }
}
`

/**
 * Source to run in the agent world: the helpers, then `expression` (which may use `bc`). It
 * answers `{ v: value }` or `{ e: message }`, since a thrown error loses its message on the way.
 */
export function inPage(expression: string): string {
  return `(() => { try {${PRELUDE}\nreturn { v: (${expression}) }\n} catch (err) { return { e: String((err && err.message) || err) } } })()`
}
