# Vendored source

This package contains the `electron-chrome-extensions` 4.10.0 source from
[samuelmaddock/electron-browser-shell](https://github.com/samuelmaddock/electron-browser-shell),
cloned at commit `3817c4236f8511156086eb4541f364679b277b40`.

The upstream MIT license is preserved in `LICENSE.md`. BeddCode's local adaptations include the
package metadata and declaration files, resolving the bundled CommonJS preload emitted by
`apps/desktop`, and `chrome.storage.session` support adapted from draft PR
[samuelmaddock/electron-browser-shell#182](https://github.com/samuelmaddock/electron-browser-shell/pull/182)
commit `9501113fd727c2e6b223349ebd911e39d5415c12`. The adapted event dispatch is scoped to the
originating extension so another installed extension cannot observe its session-storage changes.
