// Pick the saved theme before the first paint so a light window never flashes dark.
try {
  var saved = JSON.parse(localStorage.getItem('beddcode.app-preferences.v1') || 'null')
  var pref = saved && saved.theme
  var light =
    pref === 'light' ||
    (pref === 'system' && window.matchMedia('(prefers-color-scheme: light)').matches)
  if (light) document.documentElement.dataset.theme = 'light'
} catch {}
