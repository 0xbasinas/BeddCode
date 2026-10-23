/**
 * Runs inside every page of the Browser pane. While picking, a tap highlights the element under the
 * finger instead of following a link, and reports it to the app, which asks what to tell the agent.
 * It mirrors the desktop picker (selector path, outer HTML, visible bounds) but works with touch.
 */
export const PICKER_SCRIPT = `
(function () {
  if (window.__beddPick) return;
  var active = false;
  var overlay = null;
  function post(message) {
    if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(message));
  }
  function selectorOf(target) {
    var parts = [];
    var node = target;
    while (node && node.nodeType === 1) {
      if (node.id) {
        parts.unshift('#' + CSS.escape(node.id));
        break;
      }
      var part = node.localName;
      var parent = node.parentElement;
      if (parent) {
        var siblings = Array.prototype.filter.call(parent.children, function (s) {
          return s.localName === node.localName;
        });
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(' > ');
  }
  function highlight(element) {
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.style.cssText =
        'position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #60a5fa;background:rgba(96,165,250,.15);box-sizing:border-box;';
      document.documentElement.appendChild(overlay);
    }
    var r = element.getBoundingClientRect();
    overlay.style.left = r.left + 'px';
    overlay.style.top = r.top + 'px';
    overlay.style.width = r.width + 'px';
    overlay.style.height = r.height + 'px';
  }
  function onClick(event) {
    if (!active) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    var target = event.target;
    if (!target || target === overlay || target.nodeType !== 1) return;
    highlight(target);
    var html = target.outerHTML;
    var r = target.getBoundingClientRect();
    var x = Math.max(0, Math.floor(r.left));
    var y = Math.max(0, Math.floor(r.top));
    post({
      type: 'picked',
      element: {
        url: String(document.URL).slice(0, 8192),
        title: String(document.title).slice(0, 1024),
        selector: selectorOf(target).slice(0, 8192),
        html: html.slice(0, 100000),
        truncated: html.length > 100000,
        rect: {
          x: x,
          y: y,
          width: Math.max(0, Math.min(window.innerWidth, Math.ceil(r.right)) - x),
          height: Math.max(0, Math.min(window.innerHeight, Math.ceil(r.bottom)) - y)
        }
      }
    });
  }
  window.__beddPick = {
    start: function () {
      active = true;
    },
    stop: function () {
      active = false;
      if (overlay) {
        overlay.remove();
        overlay = null;
      }
    }
  };
  document.addEventListener('click', onClick, true);
  window.addEventListener('pagehide', function () {
    active = false;
  });
})();
true;
`

export const START_PICKING = 'window.__beddPick && window.__beddPick.start(); true;'
export const STOP_PICKING = 'window.__beddPick && window.__beddPick.stop(); true;'
