# Changelog

## v0.2.0 (v2) — 2026-09

The agent can now actually drive a real browser, not just a DOM.

### Real keyboard input (CDP)

- New `browser_send_keys` uses `chrome.debugger` + `Input.dispatchKeyEvent`,
  so terminals (xterm.js, term.js, tty.js), canvas editors and code editors
  receive genuine keystrokes the renderer cannot distinguish from a human.
- Typed text is **read back and verified** before `Enter` is pressed. If the
  characters that landed don't match what was sent, `Enter` is withheld,
  the line is cleared with `Ctrl+U`, and the call retries at increasing
  delays — so a half-typed `aws s3 ls` is never executed.
- `browser_press_key` parses chords (`Ctrl+Shift+P`), named keys (`F12`,
  `ArrowDown`) and rejects anything it can't faithfully produce instead of
  silently sending key code 0.
- US-layout key tables cover shifted and punctuation characters; Shift is
  held automatically when needed.

### Frame-aware actions

- `browser_focus_frame` validates the `frameId` against the live frame
  tree, probes the frame before committing, and leaves focus untouched on
  failure. Rejections list the real frame ids.
- `sendToContent` no longer falls back to frame 0. Every observation is
  stamped with the frame that actually served it.
- `browser_iframes` is built from `chrome.webNavigation.getAllFrames` and
  probes each frame for reachability, interactive-element count and a text
  preview.
- `browser_extract_from_tab` takes a `frameId` instead of always reading
  the outer shell.

### Terminal reading

- New `browser_read_terminal` handles xterm-DOM, xterm-accessibility and
  term.js/tty.js.
- For canvas-rendered xterm.js (code-server, modern VS Code) the tool
  reports "no selector will ever work" instead of burning steps on guesses.

### Reading long pages

- `browser_page_text` now takes `offset` and returns `totalChars` /
  `nextOffset`, so long documents are read in chunks. The result says
  outright that scrolling won't help.

### Robustness

- Loop guard: making the same call with the same arguments and getting
  the same result three times now attaches a `loopWarning` to the
  observation.
- `browser_extract` accepts `innerText`, `textContent`, `innerHTML`,
  `outerHTML`, `value`, and plain attribute names. JS property paths like
  `parentElement.outerHTML` are rejected with guidance.
- `browser_scroll` finds the element that actually scrolls (often an
  inner container, not the document) and reports `scrollTop` /
  `scrollHeight` / `atTop` / `atBottom`.
- `browser_click_text` reports hidden matches (with their `href`) when
  nothing visible matches — usually a signal that the real control lives
  in another frame.
- `browser_wait` is capped at 30s and the result says when it clamped.
- Visibility uses `checkVisibility()` instead of `offsetParent`, so
  `position: fixed` toolbars and modals are no longer invisible.
- The optional "BU" badge is off by default and top-frame only.

### Defaults

- `maxSteps` raised from 40 to 60.

## v0.1.0 (v1)

First public build.

- MV3 service worker, side panel UI, content script in every frame.
- Chat mode with auto page context and quick-action chips.
- Agent loop: snapshot → plan → execute → observe → repeat.
- DOM-level click/type/extract/scroll, no `chrome.debugger` yet.
- OpenAI-compatible endpoints (OpenAI, DeepSeek, OpenRouter, Ollama).