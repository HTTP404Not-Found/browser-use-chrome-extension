# Browser Use — AI agent in your Chrome sidebar

A Chrome extension that puts an AI agent (à la Perplexity Comet) inside Chrome. It can
chat with you about the current page, summarize it, translate it — and in **Agent** mode
it can drive the browser for you: clicking links, filling forms, navigating, scraping.

It works with any OpenAI-compatible API endpoint (OpenAI, DeepSeek, OpenRouter, vLLM,
Ollama, etc.).

## Features

- **Side panel chat** with streaming responses
- Automatic page context: the model sees the current page (URL, title, content) for
  grounded answers
- **Agent mode**: high-level tasks like *"Find the cheapest iPhone on Amazon and add it
  to my cart"* — the agent plans, clicks, types, scrolls, observes, repeats until done
- **Quick actions**: summarize, extract facts, translate, ELI5
- **Right-click** any selected text → "Ask Browser Use about this"
- Tab switching and multi-tab tasks (browser_tabs, browser_new_tab, browser_switch_tab)
- Asking the user clarifying questions mid-task (browser_ask_user)
- Configurable: any OpenAI-compatible endpoint

## Install (unpacked, dev mode)

1. Clone or copy this folder.
2. Open Chrome → `chrome://extensions/`.
3. Toggle **Developer mode** on (top right).
4. Click **Load unpacked** → choose the `src/` folder inside this project.
5. The Browser Use icon appears in your toolbar. Click it to open the side panel.
6. Click the ⚙ button (or the extension's "Options" link) and set your API key, base
   URL, and model.

## Use

### Chat tab

Type a question in the composer. The current page content is automatically attached as
context (toggle the "Include page" checkbox off if you don't want that). Use the quick
chips for one-click summaries, translations, etc.

### Agent tab

Describe a goal in plain language. The agent will:

1. Open the current page (or navigate somewhere new)
2. Take a numbered snapshot of all interactive elements
3. Decide what to click/type/navigate next
5. Repeat until the task is done, then call `browser_done` with a final answer

You can press **Stop** at any time. If the agent asks you a clarifying question
(via `browser_ask_user`), the composer will switch to "answer mode".

### Right-click

Select any text on any page → right-click → **Ask Browser Use about "%s"**. This opens
the side panel with the selection pre-filled.

## API compatibility

Any OpenAI-compatible endpoint that supports `POST /chat/completions` with:

- Server-sent events streaming (`stream: true`)
- Function calling / tool use (for Agent mode)

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
│   └── options.js             settings page
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

## How browser automation works

The agent doesn't use the heavyweight `chrome.debugger` API. Instead it runs DOM-level
interactions through a content script:

1. `browser_snapshot` injects `data-bu-ref="N"` attributes on every visible
   interactive element and returns a numbered list.
2. `browser_click`, `browser_type`, etc. look up `[data-bu-ref="N"]` and dispatch
   real DOM events (click, input, change, keydown).
3. `browser_navigate` uses `chrome.tabs.update`. `browser_new_tab` /
   `browser_switch_tab` manage tabs.

This keeps the extension lightweight and avoids the user-facing "attach debugger"
prompt. The trade-off: it can't easily do vision-grounded actions on canvas-rendered
pages. For those, you'd want a CDP-backed approach (out of scope for v1).

## Security note

The API key is stored in `chrome.storage.local`, which is encrypted on disk by Chrome
on most platforms but is technically readable from the extension's own process. Don't
use this extension on a shared computer with sensitive credentials, and rotate your key
if you suspect exposure.

## Limitations

- Doesn't handle `chrome://`, `chrome-extension://`, or the Chrome Web Store (you can't
  inject a content script there).
- Some sites use Shadow DOM or virtualized lists that aren't fully visible to the
  snapshot helper.
- Login walls and 2FA need `browser_ask_user` (the agent will prompt you when needed).
- No vision / screenshots in v1.

## License

MIT. Use at your own risk — browser automation can do destructive things if you give
the agent the wrong task.