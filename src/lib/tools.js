// lib/tools.js
// Browser action tool definitions (OpenAI function-calling format).
// Used by the agent loop. All actions are executed in the content script
// (which runs in the page's main world via chrome.scripting.executeScript).

export const BROWSER_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'browser_navigate',
      description:
        'Navigate the current tab to the given absolute URL. Use this when you need to open a new page.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Absolute URL, including scheme.' }
        },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_snapshot',
      description:
        'Get a structured snapshot of the current page: URL, title, and a numbered list of interactive elements (links, buttons, inputs, selects, textareas). Each element has a [N] ref that you can pass to other actions like click/type. Always snapshot first when you arrive on a page you have not seen.',
      parameters: { type: 'object', properties: {}, additionalProperties: false }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_click',
      description:
        'Click an element identified by the [N] ref returned from browser_snapshot.',
      parameters: {
        type: 'object',
        properties: {
          ref: {
            type: 'integer',
            description: 'The numbered reference of the element to click.'
          }
        },
        required: ['ref']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_type',
      description:
        'Type text into an <input>, <textarea> or contenteditable identified by its [N] ref. Clears the field first. This sets the element value directly, so it only works on genuinely editable elements — if it returns "Element is not editable" the target is a terminal, canvas or custom editor, and you must use browser_send_keys instead (click the element first to focus it).',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'integer', description: 'Numbered ref of the input.' },
          text: { type: 'string', description: 'Text to type.' },
          submit: {
            type: 'boolean',
            description: 'Press Enter after typing (default false).'
          }
        },
        required: ['ref', 'text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_read_terminal',
      description:
        'Read the visible buffer of a terminal in the FOCUS FRAME (xterm.js, term.js/tty.js, or an Ace-based terminal such as AWS CloudShell). When several terminals exist it reads the focused one, else the last visible one. browser_send_keys with submit:true already returns command output, so you only need this when that output was cut short or finished was false. Use this instead of guessing CSS selectors after running a command — terminal internals differ per renderer and selector-guessing does not converge. If it reports renderer "xterm-canvas", the output is drawn to a <canvas> and genuinely cannot be read from the DOM by any selector: stop trying, and instead redirect the command output to a file and read that file from a terminal you can read.',
      parameters: {
        type: 'object',
        properties: {
          maxChars: { type: 'integer', description: 'Max characters of the tail to return (default 4000).' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_focus_terminal',
      description:
        'Focus the input element of a terminal in the FOCUS FRAME: the xterm.js helper textarea, the Ace text input of an Ace-based terminal (AWS CloudShell), or the focusable .terminal DIV that term.js listens on. Real key events silently no-op when the wrong element is focused. Call this AFTER clicking "Launch Terminal" / "Start Lab" and waiting for the prompt, BEFORE the first browser_send_keys. Returns ok:true when focus lands on such an input. If it returns ok:false, the terminal likely has not finished launching, or it uses a canvas renderer that has no DOM input at all (browser_read_terminal renderer=xterm-canvas) — in which case no real input will ever work.',
      parameters: { type: 'object', properties: {}, additionalProperties: false }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_send_keys',
      description:
        'Send text as REAL input to whatever has focus in the FOCUS tab. This is the only way to drive terminals (lab consoles, xterm.js, term.js, AWS CloudShell), code editors and canvas apps — they ignore synthetic events, so browser_type fails on them. The whole string is pasted in one go when the target accepts that (otherwise it is typed as key events), so multi-line text such as a heredoc (cat > file <<\'EOF\' ... EOF) belongs in ONE call. The text is read back before Enter: if it did not land, Enter is withheld and the result explains why. With submit:true on a terminal it presses Enter, waits for the shell prompt to return, and returns `output` (what the command printed) plus `finished` — so do NOT call browser_read_terminal or browser_page_text afterwards unless finished is false. `verified: null` means the target could not be read back (canvas terminal). For keys and chords (Ctrl+C, Escape, arrows) use browser_press_key. For ordinary <input>/<textarea> form fields, browser_type is simpler.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The whole text to send. May contain newlines.' },
          submit: { type: 'boolean', description: 'Press Enter afterwards (default false). Use true to run a shell command.' },
          waitMs: { type: 'integer', description: 'After submit on a terminal, max milliseconds to wait for the prompt to return (default 8000, cap 30000). Raise it for slow commands such as pip install or large uploads instead of calling browser_wait; 0 skips output capture.' },
          delayMs: { type: 'integer', description: 'Milliseconds between keystrokes when key events are used (default 10). Raise it only if a target proves lossy.' }
        },
        required: ['text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_press_key',
      description: 'Press a single key, or a chord, as real input to whatever has focus in the FOCUS tab. Do NOT use it to type words or commands one character at a time: the third single-character press in a row is refused — send text with browser_send_keys. Accepts one character ("a", "/"), a named key ("Enter", "Escape", "F5", "ArrowDown", "PageUp"), or modifiers joined with + ("Ctrl+C", "Ctrl+Shift+P", "Alt+F4"). Anything it cannot faithfully produce is REJECTED with ok:false rather than silently doing nothing. To type a whole string use browser_send_keys instead. Note that keys do not scroll a page that is not focused on its scroll container — to read more text use browser_page_text with an offset.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Key name, e.g. "Enter", "Escape".' }
        },
        required: ['key']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_scroll',
      description: 'Scroll the FOCUS FRAME up or down by roughly the given amount in pixels. It finds the element that actually scrolls (often an inner container, not the document) and reports scrollTop/scrollHeight/atTop/atBottom plus whether anything moved. Scrolling is for triggering lazy-loaded content or bringing a control into view — it does NOT reveal more text to browser_page_text, which always returns the whole document.',
      parameters: {
        type: 'object',
        properties: {
          direction: { type: 'string', enum: ['up', 'down'] },
          amount: { type: 'integer', description: 'Pixels to scroll (default 600).' }
        },
        required: ['direction']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_extract',
      description:
        'Extract text or attribute from elements matching a CSS selector on the FOCUS tab. Returns an array of strings. Use empty attr to get visible text.',
      parameters: {
        type: 'object',
        properties: {
          selector: {
            type: 'string',
            description: 'CSS selector, e.g. "h1", ".price", "a[href*=product]".'
          },
          attr: {
            type: 'string',
            description: 'One of: innerText, textContent, innerHTML, outerHTML, value, or a plain HTML attribute name (href, id, src...). Omit or set "" for visible text. JS property paths like "parentElement.outerHTML" are NOT supported and are rejected — write a CSS selector that reaches the element instead. A null value means the attribute is absent.'
          },
          limit: { type: 'integer', description: 'Max number of items (default 20).' }
        },
        required: ['selector']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_extract_from_tab',
      description:
        'Extract text or attribute from a specific tab WITHOUT switching the focus. Use this to read content from a tab in the background while the user is looking at another tab. Returns an array of strings.',
      parameters: {
        type: 'object',
        properties: {
          tabId: {
            type: 'integer',
            description: 'Target tab id (from browser_tabs).'
          },
          selector: {
            type: 'string',
            description: 'CSS selector.'
          },
          attr: {
            type: 'string',
            description: 'Attribute name. Omit or set "" for visible text.'
          },
          limit: { type: 'integer', description: 'Max number of items (default 20).' },
          frameId: {
            type: 'integer',
            description: 'Frame within that tab (default 0 = top document). If the tab content lives in an iframe, frame 0 usually returns only the outer shell.'
          }
        },
        required: ['tabId', 'selector']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_page_text',
      description:
        'Get the readable text of the FOCUS FRAME (cleaned, reader-view style). It returns the WHOLE document every time, independent of scroll position — scrolling and then calling this again gives byte-identical output, so never do that. For long pages, read the first chunk, then call again with offset set to the nextOffset value from the previous result. The result reports offset, returnedChars, totalChars and nextOffset.',
      parameters: {
        type: 'object',
        properties: {
          tabId: {
            type: 'integer',
            description: 'Target tab id. Omit to use the focus tab.'
          },
          maxChars: {
            type: 'integer',
            description: 'Max characters to return per call (default 6000, cap 30000).'
          },
          offset: {
            type: 'integer',
            description: 'Character offset to start from. Pass the nextOffset from the previous call to read the next chunk.'
          },
          frameId: {
            type: 'integer',
            description: 'Read a specific frame instead of the current focus frame. Omit to use the focus frame.'
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_iframes',
      description:
        'List EVERY live frame in the FOCUS tab (the real Chrome frame tree, not just <iframe> tags). Each entry has frameId, parentFrameId, depth, url, title, reachable, interactiveCount and textPreview. Frame ids are arbitrary numbers assigned by Chrome — they are NOT 0,1,2, and you must never guess one. Call this BEFORE browser_focus_frame, every time. Modern content lives inside frames (LMS lab consoles, embedded terminals, editors, OAuth). Pick a frame with reachable:true and a high interactiveCount or a meaningful textPreview; the response also names a suggestedFrameId. reachable:false means the extension cannot script that frame — open its url with browser_new_tab instead.',
      parameters: { type: 'object', properties: {}, additionalProperties: false }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_focus_frame',
      description:
        'Switch focus to a different frame inside the FOCUS tab. You MUST pass a frameId taken verbatim from a browser_iframes call — guessed values are rejected, and the focus is left unchanged. Pass 0 to return to the top document. The switch is verified: it only succeeds if the frame exists AND can be scripted, and the result echoes that frame url, title and interactiveCount so you can confirm you moved. After a successful switch, every browser_* action targets that frame until you switch again or change tabs.',
      parameters: {
        type: 'object',
        properties: {
          frameId: {
            type: 'integer',
            description: 'A frameId copied exactly from browser_iframes, or 0 for the top document. Never invent this number.'
          }
        },
        required: ['frameId']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_click_text',
      description:
        'Click the most likely VISIBLE element in the FOCUS FRAME whose text contains the given substring. Use this when you know the label of a button/link but its [N] ref is hard to locate (long lists, dynamic DOM, repeated text). Returns the top 3 candidates so you can verify the right one was clicked. If the text exists but is hidden, the failure lists those hiddenMatches with their href — a hidden match usually means the real control is inside a frame, so call browser_iframes next. Prefer this over browser_click(ref) when the text is descriptive and unique.',
      parameters: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: 'Substring of the link/button text. Case-insensitive.'
          },
          exact: {
            type: 'boolean',
            description: 'Require exact match (default false, substring match).'
          }
        },
        required: ['text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_wait',
      description: 'Wait for the given number of milliseconds (for slow pages or animations). Requests above the cap are clamped and the result says so. Waiting does not change the page by itself — if two snapshots in a row look identical, waiting again will not help; change approach instead.',
      parameters: {
        type: 'object',
        properties: { ms: { type: 'integer', description: 'Milliseconds (capped at 30000).' } },
        required: ['ms']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_new_tab',
      description: 'Open a new tab with the given URL and make it your focus tab. Returns the new tab id. If the user is looking at a tab that is not yours, it opens in the background instead of taking over their window.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_switch_tab',
      description: 'Make another tab your focus tab, by its id from browser_new_tab or browser_tabs. Tabs that another agent run is driving are refused. The browser window only switches to the tab if the user is already looking at one of your tabs.',
      parameters: {
        type: 'object',
        properties: { tabId: { type: 'integer' } },
        required: ['tabId']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_tabs',
      description: 'List the currently open tabs in this window.',
      parameters: { type: 'object', properties: {}, additionalProperties: false }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_done',
      description:
        'Call this when the user task is complete. Provide a concise final answer for the user.',
      parameters: {
        type: 'object',
        properties: {
          result: { type: 'string', description: 'Final answer to deliver to the user.' }
        },
        required: ['result']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_ask_user',
      description:
        'Ask the user a clarifying question and pause the agent until they reply. Use this when you cannot proceed without more information.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The question to ask the user.' }
        },
        required: ['question']
      }
    }
  }
];

export const TOOL_NAME_SET = new Set(BROWSER_TOOLS.map((t) => t.function.name));