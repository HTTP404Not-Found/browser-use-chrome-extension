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
        'Type text into an input or textarea identified by its [N] ref. Clears the field first, then types the given text.',
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
      name: 'browser_press_key',
      description: 'Press a keyboard key (Enter, Tab, Escape, ArrowDown, ArrowUp, etc.).',
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
      description: 'Scroll the current viewport up or down by roughly the given amount in pixels.',
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
            description: 'Attribute name. Omit or set "" for visible text.'
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
          limit: { type: 'integer', description: 'Max number of items (default 20).' }
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
        'Get the main textual content of the FOCUS tab (cleaned, similar to a reader view). Use this when you need a long page summarized in chat or to compare two pages.',
      parameters: {
        type: 'object',
        properties: {
          tabId: {
            type: 'integer',
            description: 'Target tab id. Omit to use the focus tab.'
          },
          maxChars: {
            type: 'integer',
            description: 'Max characters to return (default 6000).'
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
        'List the iframes present on the FOCUS tab with their index, id, name, src, size, AND frameId. Modern content runs inside iframes (Canvas LMS lab UI, embedded editors, OAuth flows). The frameId is what you pass to browser_focus_frame to switch your actions into that iframe. After switching, browser_snapshot, browser_click_text, browser_click, browser_type, browser_extract, and browser_page_text all operate inside the chosen frame.',
      parameters: { type: 'object', properties: {}, additionalProperties: false }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_focus_frame',
      description:
        'Switch the focus to a different frame inside the FOCUS tab. Pass frameId returned by browser_iframes. Pass 0 to return to the top document. After calling this, every subsequent browser_* action targets that frame until you switch back or change tabs.',
      parameters: {
        type: 'object',
        properties: {
          frameId: {
            type: 'integer',
            description: 'Frame id (0 = top document). Use the value from browser_iframes for inner iframes.'
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
        'Click the most likely visible element on the FOCUS tab whose text contains the given substring. Use this when you know the label of a button/link but its [N] ref from browser_snapshot is hard to locate (long lists, dynamic DOM, repeated text). Returns the top 3 candidates so you can verify the right one was clicked. Prefer this over browser_click(ref) when text is descriptive and unique.',
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
      description: 'Wait for the given number of milliseconds (for slow pages or animations).',
      parameters: {
        type: 'object',
        properties: { ms: { type: 'integer', description: 'Milliseconds (max 5000).' } },
        required: ['ms']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_new_tab',
      description: 'Open a new tab with the given URL. Returns the new tab id.',
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
      description: 'Switch the active tab by its tab id (as returned by browser_new_tab or browser_tabs).',
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