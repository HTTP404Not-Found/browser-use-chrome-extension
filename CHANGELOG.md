# Changelog

## v0.3.0 — 2026-09

### Parallel agents, one per tab

- Runs are scoped to the tab they were started from. Starting a task or a
  chat in another tab no longer aborts the agent that is already working.
- An agent owns its start tab plus every tab it opens or switches to.
  Another run switching to one of those tabs is refused, so two agents
  never type into the same page.
- If the user is looking at a tab the agent does not own, `browser_new_tab`
  and `browser_switch_tab` work without taking over the window.
- The side panel shows the run for the tab you are viewing and replays its
  log when you come back. Other running agents are listed with a jump link.
  Stop and ask-user replies target that tab's run only.
- Finishing one run detaches the debugger only from tabs no other run uses.
- Fixed: the panel's `chat:load` request had no listener in the background,
  so switching tabs always showed an empty thread.

### Speed

- `browser_send_keys` pastes the whole text with one `Input.insertText`
  call when the target accepts it, and remembers targets that do not.
  Multi-line text is never retried (retrying duplicated heredocs).
- Echo verification polls for up to 1.5–2s instead of reading once after
  120ms, which made remote terminals retype every command three times.
- With `submit:true` on a terminal, `browser_send_keys` waits for the
  prompt and returns `output` / `finished`, so running a command is one
  LLM round trip instead of two. New `waitMs` parameter.
- `browser_send_keys({ key })` is routed to `browser_press_key`; empty text
  is an error instead of a silent `verified: true`.
- A third single-character `browser_press_key` in a row is refused.
- Before each LLM call, tool results older than the last 6 are collapsed to
  a one-line summary, long old tool-call arguments are elided, and
  `reasoning_content` is kept only for the last 3 assistant turns.
- `browser_snapshot` returns one compact line per element instead of JSON
  with selectors and coordinates.
- `browser_iframes` probes frames in parallel.
- The loop guard ignores `browser_wait`, which produced constant false
  warnings when waits were interleaved with key presses.

### Terminals

- `browser_read_terminal` reads the focused (else last visible) terminal
  instead of the one with the most text, strips row padding, and supports
  Ace-based terminals such as AWS CloudShell.
- `browser_focus_terminal` accepts a focused term.js `.terminal` DIV, which
  it used to report as a failure.

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