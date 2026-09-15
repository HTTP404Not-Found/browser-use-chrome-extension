# Browser Use — AI agent in your Chrome sidebar

A Chrome extension that puts an AI agent (à la Perplexity Comet) inside
Chrome. It can chat with you about the current page, summarize it,
translate it — and in **Agent** mode it can drive the browser for you:
clicking links, filling forms, navigating, scraping, even typing into
terminals and code editors.

Works with any OpenAI-compatible API endpoint (OpenAI, DeepSeek,
OpenRouter, vLLM, Ollama, …).

**Current version:** v3.0. See [CHANGELOG.md](./CHANGELOG.md) for
what changed since v1/v2.

## Features

- **Side-panel chat** with streaming responses.
- **Automatic page context** — the model sees URL, title and readable
  text of the current page; toggle it off when you don't want it.
- **Agent mode** for high-level tasks like *"Find the cheapest iPhone on
  Amazon and add it to my cart"* — the agent plans, clicks, types,
  scrolls, observes, repeats until done.
- **Real keyboard input** via the Chrome DevTools Protocol, so the
  agent can drive terminals (xterm.js, term.js/tty.js), code editors
  (CodeMirror, Monaco) and canvas-based widgets that ignore synthetic
  events. Typed text is verified before `Enter` is pressed.
- **Frame-aware actions** — content that lives in an `<iframe>` (LMS
  lab consoles, embedded editors, OAuth flows) is first-class. The
  agent lists the real Chrome frame tree, switches focus with a probed
  `frameId`, and every observation is stamped with the frame that
  served it.
- **Quick actions**: summarize, extract facts, translate, ELI5.
- **Right-click** any selected text → "Ask Browser Use about this".
- **Multi-tab** (`browser_tabs`, `browser_new_tab`, `browser_switch_tab`)
  and **asking the user clarifying questions** mid-task
  (`browser_ask_user`).
- **Configurable** — any OpenAI-compatible endpoint, plus a
  configurable agent step budget.

## Install (unpacked, dev mode)

1. Clone or copy this folder.
2. Open Chrome → `chrome://extensions/`.
3. Toggle **Developer mode** on (top right).
4. Click **Load unpacked** → choose the `src/` folder inside this
   project.
5. The Browser Use icon appears in your toolbar. Click it to open the
   side panel.
6. Click the ⚙ button (or the extension's "Options" link) and set your
   API key, base URL and model.

## Use

### Chat tab

Type a question in the composer. The current page content is
automatically attached as context (toggle the "Include page" checkbox
off if you don't want that). The chips below the message list are
one-click summarises, translations, ELI5, key facts.

### Agent tab

Describe a goal in plain language. The agent will:

1. Open the current page (or navigate somewhere new).
2. Take a numbered snapshot of all interactive elements.
3. Decide what to click/type/navigate next.
4. Repeat until the task is done, then call `browser_done` with a final
   answer.

You can press **Stop** at any time. If the agent asks you a clarifying
question (via `browser_ask_user`), the composer switches to answer mode.

### Right-click

Select any text on any page → right-click → **Ask Browser Use about
"%s"**. This opens the side panel with the selection pre-filled.

## API compatibility

Any OpenAI-compatible endpoint that supports `POST /chat/completions`
with:

- Server-sent events streaming (`stream: true`).
- Function calling / tool use (for Agent mode).

Tested defaults:

| Provider   | Base URL                          | Model              |
|------------|-----------------------------------|--------------------|
| OpenAI     | `https://api.openai.com/v1`       | `gpt-4o-mini`      |
| DeepSeek   | `https://api.deepseek.com/v1`     | `deepseek-chat`    |
| OpenRouter | `https://openrouter.ai/api/v1`    | (any model slug)   |
| Ollama     | `http://localhost:11434/v1`       | (a tool-capable one) |

## Project layout

```
src/
├── manifest.json              MV3 manifest
├── background.js              service worker (chat + agent orchestrator)
├── content/
│   └── extractor.js           page reading + DOM actions
├── lib/
│   ├── llm.js                 OpenAI-compatible streaming client
│   ├── tools.js               browser action definitions (function-calling format)
│   └── prompts.js             system prompts
├── sidepanel/
│   ├── index.html
│   ├── sidepanel.css
│   └── sidepanel.js           side panel UI + streaming renderer
├── options/
│   ├── options.html
│   ├── options.css
│   └── options.js              settings page
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

## How browser automation works

The agent doesn't use the heavyweight `chrome.debugger` API for
**reading**. It runs DOM-level interactions through a content script:

1. `browser_snapshot` injects `data-bu-ref="N"` attributes on every
   visible interactive element and returns a numbered list.
2. `browser_click`, `browser_type`, etc. look up `[data-bu-ref="N"]` and
   dispatch real DOM events.
3. `browser_navigate` uses `chrome.tabs.update`. `browser_new_tab` /
   `browser_switch_tab` manage tabs.
4. `browser_send_keys` / `browser_press_key` attach the DevTools
   debugger to the focus tab and use `Input.dispatchKeyEvent` so
   terminals and editors receive trusted keystrokes. The extension
   shows Chrome's "being debugged" banner on the affected tab while
   attached.

This keeps the extension lightweight and avoids the user-facing "attach
debugger" prompt for ordinary page interactions, while still being able
to drive widgets that ignore synthetic events.

## Security note

The API key is stored in `chrome.storage.local`, which is encrypted on
disk by Chrome on most platforms but is technically readable from the
extension's own process. Don't use this extension on a shared computer
with sensitive credentials, and rotate your key if you suspect
exposure.

## Limitations

- Doesn't handle `chrome://`, `chrome-extension://`, or the Chrome Web
  Store (you can't inject a content script there).
- Some sites use Shadow DOM or virtualized lists that aren't fully
  visible to the snapshot helper.
- Login walls and 2FA need `browser_ask_user` (the agent will prompt
  you when needed).
- No vision in v2 — the agent reads the DOM, not pixels. Canvas-rendered
  xterm.js terminals genuinely cannot be read from the DOM, and
  `browser_read_terminal` will say so instead of letting the agent
  burn steps guessing selectors.

## License

MIT. Use at your own risk — browser automation can do destructive
things if you give the agent the wrong task.