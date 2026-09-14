// background.js (service worker, MV3, ES module)
// Orchestrates:
//   1. Side panel open on action click
//   2. Chat streaming via SSE
//   3. Browser-use agent loop (plan → execute → observe)
//   4. Tab/navigation actions
//
// State for active chat/agent runs is held in-memory (one active run at a time)
// and persisted to chrome.storage.session so a SW restart can resume.
//
// The side panel connects via chrome.runtime.connect('bu-stream') and we pipe
// events for the active run over that port.

import { streamChat, getLlmConfig } from './lib/llm.js';
import { BROWSER_TOOLS, TOOL_NAME_SET } from './lib/tools.js';
import { CHAT_SYSTEM_PROMPT, AGENT_SYSTEM_PROMPT, buildPageContextMessage } from './lib/prompts.js';

// ---------------------------------------------------------------------------
// Side panel + icon wiring
// ---------------------------------------------------------------------------

// Tunables (maxSteps is overridable from the options page).
const DEFAULT_MAX_AGENT_STEPS = 60;
const MAX_WAIT_MS = 30000;

chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});

chrome.runtime.onInstalled.addListener(() => {
  // Seed default config if missing
  chrome.storage.local.get(['llmConfig'], (r) => {
    if (!r.llmConfig) {
      chrome.storage.local.set({
        llmConfig: {
          apiKey: '',
          baseUrl: 'https://api.openai.com/v1',
          model: 'gpt-4o-mini',
          maxContextChars: 80000,
          maxSteps: DEFAULT_MAX_AGENT_STEPS
        }
      });
    }
  });
  chrome.contextMenus?.create?.({
    id: 'bu-ask-selection',
    title: 'Ask Browser Use about "%s"',
    contexts: ['selection']
  });
});

chrome.contextMenus?.onClicked?.addListener?.((info, tab) => {
  if (info.menuItemId !== 'bu-ask-selection') return;
  // Open side panel and pass the selection through storage.
  chrome.storage.session?.set?.({ pendingSelection: { text: info.selectionText, tabId: tab?.id } });
  if (tab?.id) chrome.sidePanel?.open?.({ tabId: tab.id });
});

// ---------------------------------------------------------------------------
// Streaming port: side panel <-> service worker
// ---------------------------------------------------------------------------

const ports = new Set();
function broadcast(evt) {
  for (const p of ports) {
    try { p.postMessage(evt); } catch {}
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'bu-stream') return;
  ports.add(port);
  port.onDisconnect.addListener(() => ports.delete(port));
  port.onMessage.addListener((msg) => {
    handleClientMessage(msg, port).catch((e) => {
      port.postMessage({ type: 'error', message: String(e?.message || e) });
    });
  });
});

// ---------------------------------------------------------------------------
// Active run state
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} RunState
 * @property {'chat'|'agent'} kind
 * @property {Array} messages
 * @property {AbortController} abort
 * @property {number|null} step
 * @property {boolean} awaitingUser
 * @property {string|null} awaitingQuestion
 * @property {number|null} focusTabId  // the tab the agent is acting on
 * @property {Array} focusHistory     // [{ tabId, url, title }] for breadcrumb
 * @property {number} focusFrame      // frame within the tab (0 = top)
 */

let activeRun = null;

async function handleClientMessage(msg, port) {
  switch (msg.type) {
    case 'hello':
      port.postMessage({ type: 'hello-ack', hasActiveRun: !!activeRun, run: snapshotRun() });
      return;
    case 'chat:send': {
      const { userText, page, conversationId } = msg;
      const messages = [{ role: 'system', content: CHAT_SYSTEM_PROMPT }];
      const ctx = buildPageContextMessage(page);
      if (ctx) messages.push(ctx);
      messages.push({ role: 'user', content: userText });
      return startChat(messages, conversationId);
    }
    case 'chat:regenerate': {
      if (!activeRun || activeRun.kind !== 'chat') return;
      // Drop the last assistant message and retry.
      const m = activeRun.messages;
      while (m.length && m[m.length - 1].role === 'assistant') m.pop();
      return startChatFromState();
    }
    case 'agent:start': {
      const { task, page } = msg;
      const startTab = await getActiveTab();
      const startTabId = startTab?.id ?? null;
      const tabs = await chrome.tabs.query({ currentWindow: true });
      const tabList = tabs
        .map((t) => `  - tab ${t.id}${t.active ? ' (active)' : ''}: ${truncate(t.title || t.url || '', 80)}`)
        .join('\n');
      const messages = [
        { role: 'system', content: AGENT_SYSTEM_PROMPT },
        {
          role: 'user',
          content:
            `Task: ${task}\n\n` +
            (page
              ? `Starting page: ${page.url} — ${page.title}\n\n` +
                `Begin with browser_snapshot to see the page state.`
              : `Begin by navigating to a relevant page, then snapshot.`) +
            `\n\nOpen tabs in this window:\n${tabList}\n\n` +
            `Your focus tab starts at tab ${startTabId}. ` +
            `Use browser_tabs any time you need to check the tab landscape. ` +
            `Use browser_switch_tab to change focus, browser_new_tab to open more, ` +
            `and browser_extract_from_tab or browser_page_text to read a tab without disturbing the user.`
        }
      ];
      return startAgent(messages, startTabId);
    }
    case 'agent:userReply': {
      if (!activeRun || activeRun.kind !== 'agent' || !activeRun.awaitingUser) return;
      activeRun.awaitingUser = false;
      const question = activeRun.awaitingQuestion;
      activeRun.awaitingQuestion = null;
      activeRun.messages.push({
        role: 'user',
        content: `User reply: ${msg.text}\n(Original question you asked: ${question})`
      });
      return resumeAgent();
    }
    case 'abort':
      if (activeRun) {
        activeRun.abort.abort();
      }
      await detachAllDebuggers();
      return;
  }
}

function snapshotRun() {
  if (!activeRun) return null;
  return {
    kind: activeRun.kind,
    step: activeRun.step,
    awaitingUser: activeRun.awaitingUser,
    awaitingQuestion: activeRun.awaitingQuestion,
    focusTabId: activeRun.focusTabId ?? null,
    focusFrame: activeRun.focusFrame ?? 0,
    focusHistory: activeRun.focusHistory ?? []
  };
}

function truncate(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n) + '…' : s;
}

async function recordFocus(tabId, frameId) {
  if (!activeRun || tabId == null) return;
  activeRun.focusTabId = tabId;
  if (typeof frameId === 'number') activeRun.focusFrame = frameId;
  try {
    const t = await chrome.tabs.get(tabId);
    activeRun.focusHistory = (activeRun.focusHistory || []).concat([{ tabId, url: t.url, title: t.title }]).slice(-10);
    broadcast({ type: 'agent:focus', tabId, frameId: activeRun.focusFrame ?? 0, url: t.url, title: t.title, history: activeRun.focusHistory });
  } catch {
    broadcast({ type: 'agent:focus', tabId, frameId: activeRun.focusFrame ?? 0 });
  }
}

// ---------------------------------------------------------------------------
// Chat run (single LLM turn, streaming)
// ---------------------------------------------------------------------------

async function startChat(messages, conversationId) {
  if (activeRun) activeRun.abort.abort();
  const abort = new AbortController();
  activeRun = { kind: 'chat', messages, abort, step: 0, awaitingUser: false, awaitingQuestion: null, focusTabId: null, focusHistory: [], focusFrame: 0 };

  broadcast({ type: 'run:start', kind: 'chat' });
  await runChatOnce();
}

async function startChatFromState() {
  if (!activeRun) return;
  broadcast({ type: 'run:start', kind: 'chat', resume: true });
  await runChatOnce();
}

async function runChatOnce() {
  try {
    const final = await streamChat({
      messages: activeRun.messages,
      signal: activeRun.abort.signal,
      onDelta: (content) => broadcast({ type: 'token', content }),
      onReasoningDelta: (content) => broadcast({ type: 'reasoning', content }),
      onError: (e) => broadcast({ type: 'error', message: String(e.message || e) }),
      onDone: (finalMsg) => {
        activeRun.messages.push(finalMsg);
      }
    });
    broadcast({ type: 'run:end', kind: 'chat', finalMessage: final });
  } catch (e) {
    broadcast({ type: 'error', message: String(e.message || e) });
    broadcast({ type: 'run:end', kind: 'chat', error: true });
  }
}

// ---------------------------------------------------------------------------
// Agent run (loop with tool execution)
// ---------------------------------------------------------------------------

async function getMaxAgentSteps() {
  try {
    const cfg = await getLlmConfig();
    const n = Number(cfg?.maxSteps);
    if (Number.isFinite(n) && n >= 5 && n <= 200) return Math.floor(n);
  } catch {}
  return DEFAULT_MAX_AGENT_STEPS;
}

async function startAgent(messages, focusTabId) {
  if (activeRun) activeRun.abort.abort();
  const abort = new AbortController();
  activeRun = {
    kind: 'agent',
    messages,
    abort,
    step: 0,
    awaitingUser: false,
    awaitingQuestion: null,
    focusTabId: focusTabId ?? null,
    focusFrame: 0,
    focusHistory: []
  };
  broadcast({ type: 'run:start', kind: 'agent' });
  if (focusTabId != null) await recordFocus(focusTabId);
  return resumeAgent();
}

async function resumeAgent() {
  try {
    while (activeRun && activeRun.kind === 'agent' && !activeRun.abort.signal.aborted) {
      if (activeRun.awaitingUser) return; // paused
      activeRun.step += 1;
      const maxSteps = await getMaxAgentSteps();
      if (activeRun.step > maxSteps) {
        broadcast({
          type: 'error',
          message:
            `Agent hit max steps (${maxSteps}). Raise "maxSteps" in the extension options, ` +
            `or give a narrower task. If the run was repeating the same action, the page state was probably not changing.`
        });
        break;
      }
      broadcast({ type: 'agent:step', step: activeRun.step });
      const final = await streamChat({
        messages: activeRun.messages,
        tools: BROWSER_TOOLS,
        toolChoice: 'auto',
        signal: activeRun.abort.signal,
        onDelta: (content) => broadcast({ type: 'token', content }),
        onReasoningDelta: (content) => broadcast({ type: 'reasoning', content }),
        onError: (e) => broadcast({ type: 'error', message: String(e.message || e) }),
        onDone: (finalMsg) => {
          activeRun.messages.push(finalMsg);
        }
      });

      const toolCalls = final.tool_calls;
      if (!toolCalls || toolCalls.length === 0) {
        // Plain text answer. End the run.
        broadcast({ type: 'run:end', kind: 'agent', finalMessage: final });
        break;
      }

      // Execute tool calls sequentially.
      const toolResults = [];
      for (const tc of toolCalls) {
        if (activeRun.abort.signal.aborted) break;
        const name = tc.function.name;
        let args = {};
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch {}
        broadcast({ type: 'agent:toolCall', name, args });
        let observation;
        try {
          observation = await executeTool(name, args);
        } catch (e) {
          observation = { ok: false, error: String(e.message || e) };
        }
        // Loop guard: identical call + identical result means the page is not
        // responding to this approach, and repeating it will not change that.
        const sig = name + '|' + JSON.stringify(args) + '|' + JSON.stringify(observation).slice(0, 500);
        activeRun.recentCalls = (activeRun.recentCalls || []).concat([sig]).slice(-8);
        const repeats = activeRun.recentCalls.filter((x) => x === sig).length;
        if (repeats >= 3 && observation && typeof observation === 'object') {
          observation.loopWarning =
            `You have now made this exact call ${repeats} times and received the same result each time. ` +
            'Repeating it again will not change anything. Change approach, or call browser_ask_user.';
        }
        broadcast({ type: 'agent:toolResult', name, observation });
        toolResults.push({
          role: 'tool',
          tool_call_id: tc.id,
          name,
          content: JSON.stringify(observation).slice(0, 20000)
        });
        // Handle special tools that pause/end the loop.
        if (name === 'browser_done') {
          activeRun.messages.push(...toolResults);
          await detachAllDebuggers();
          broadcast({ type: 'run:end', kind: 'agent', finalMessage: { role: 'assistant', content: observation.result || final.content } });
          activeRun = null;
          return;
        }
        if (name === 'browser_ask_user') {
          activeRun.awaitingUser = true;
          activeRun.awaitingQuestion = args.question || '(no question)';
          activeRun.messages.push(...toolResults);
          broadcast({ type: 'agent:awaitingUser', question: activeRun.awaitingQuestion });
          return;
        }
      }
      activeRun.messages.push(...toolResults);
    }
  } catch (e) {
    broadcast({ type: 'error', message: String(e.message || e) });
    broadcast({ type: 'run:end', kind: 'agent', error: true });
  }
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

async function executeTool(name, args) {
  if (!TOOL_NAME_SET.has(name)) return { ok: false, error: `Unknown tool ${name}` };

  switch (name) {
    case 'browser_navigate':
      return doNavigate(args.url);
    case 'browser_new_tab':
      return doNewTab(args.url);
    case 'browser_switch_tab':
      return doSwitchTab(args.tabId);
    case 'browser_tabs':
      return doListTabs();
    case 'browser_snapshot':
      return doSnapshot();
    case 'browser_click':
      return doClick(args.ref);
    case 'browser_type':
      return doType(args.ref, args.text, args.submit);
    case 'browser_press_key':
      return doPressKey(args.key);
    case 'browser_send_keys':
      return doSendKeys(args.text, args.submit, { delayMs: args.delayMs });
    case 'browser_read_terminal':
      return doReadTerminal(args.maxChars);
    case 'browser_scroll':
      return doScroll(args.direction, args.amount);
    case 'browser_extract':
      return doExtract(args.selector, args.attr, args.limit);
    case 'browser_extract_from_tab':
      return doExtractFromTab(args.tabId, args.selector, args.attr, args.limit, args.frameId);
    case 'browser_page_text':
      return doPageText(args.tabId, args.maxChars, args.frameId, args.offset);
    case 'browser_iframes':
      return doListIframes();
    case 'browser_focus_frame':
      return doFocusFrame(args.frameId);
    case 'browser_click_text':
      return doClickText(args.text, args.exact);
    case 'browser_wait': {
      // Was silently clamped to 5000, so a request for 10000 reported
      // "waited: 5000" with no explanation and the agent kept re-waiting.
      const requested = Math.max(0, Number(args.ms) || 0);
      const ms = Math.min(MAX_WAIT_MS, requested);
      await new Promise((r) => setTimeout(r, ms));
      return ms < requested
        ? { ok: true, waited: ms, requested, clamped: true, note: `Waits are capped at ${MAX_WAIT_MS}ms. Call browser_wait again if you need longer.` }
        : { ok: true, waited: ms };
    }
    case 'browser_done':
      return { ok: true, result: args.result || '' };
    case 'browser_ask_user':
      return { ok: true, question: args.question || '' };
    default:
      return { ok: false, error: 'unhandled' };
  }
}

// ---------------------------------------------------------------------------
// Real (trusted) input via the Chrome DevTools Protocol
// ---------------------------------------------------------------------------
// Synthetic KeyboardEvents are untrusted. Terminal emulators (term.js/tty.js,
// xterm.js), canvas editors and most IME-aware widgets ignore them outright,
// which is why typing a command into a lab terminal did nothing. CDP
// Input.dispatchKeyEvent produces real input the renderer cannot tell from a
// human. Attaching shows Chrome's "being debugged" banner on that tab — that
// visibility is intentional.

const attachedTabs = new Set();

// Key tables. The previous version derived a "virtual key code" from the
// character code, which is only correct for A-Z and 0-9. Every shifted or
// punctuation character got a bogus code — `"` was sent as 34, which is
// PAGE DOWN — and no Shift modifier was ever set. Chrome then dropped or
// rewrote those keystrokes, so `aws s3 ls` arrived at the shell as `w 3 l`.

const NAMED_KEYS = {
  Enter: { vk: 13, code: 'Enter', text: '\r' },
  Tab: { vk: 9, code: 'Tab', text: '\t' },
  Escape: { vk: 27, code: 'Escape' },
  Backspace: { vk: 8, code: 'Backspace' },
  Delete: { vk: 46, code: 'Delete' },
  ArrowUp: { vk: 38, code: 'ArrowUp' },
  ArrowDown: { vk: 40, code: 'ArrowDown' },
  ArrowLeft: { vk: 37, code: 'ArrowLeft' },
  ArrowRight: { vk: 39, code: 'ArrowRight' },
  Home: { vk: 36, code: 'Home' },
  End: { vk: 35, code: 'End' },
  PageUp: { vk: 33, code: 'PageUp' },
  PageDown: { vk: 34, code: 'PageDown' },
  Insert: { vk: 45, code: 'Insert' }
};
for (let i = 1; i <= 12; i++) NAMED_KEYS['F' + i] = { vk: 111 + i, code: 'F' + i };

// character -> [virtual key code, needs shift, code]
const CHAR_KEYS = {
  ' ': [32, false, 'Space'],
  '`': [192, false, 'Backquote'], '~': [192, true, 'Backquote'],
  '-': [189, false, 'Minus'], '_': [189, true, 'Minus'],
  '=': [187, false, 'Equal'], '+': [187, true, 'Equal'],
  '[': [219, false, 'BracketLeft'], '{': [219, true, 'BracketLeft'],
  ']': [221, false, 'BracketRight'], '}': [221, true, 'BracketRight'],
  '\\': [220, false, 'Backslash'], '|': [220, true, 'Backslash'],
  ';': [186, false, 'Semicolon'], ':': [186, true, 'Semicolon'],
  "'": [222, false, 'Quote'], '"': [222, true, 'Quote'],
  ',': [188, false, 'Comma'], '<': [188, true, 'Comma'],
  '.': [190, false, 'Period'], '>': [190, true, 'Period'],
  '/': [191, false, 'Slash'], '?': [191, true, 'Slash'],
  '1': [49, false, 'Digit1'], '!': [49, true, 'Digit1'],
  '2': [50, false, 'Digit2'], '@': [50, true, 'Digit2'],
  '3': [51, false, 'Digit3'], '#': [51, true, 'Digit3'],
  '4': [52, false, 'Digit4'], '$': [52, true, 'Digit4'],
  '5': [53, false, 'Digit5'], '%': [53, true, 'Digit5'],
  '6': [54, false, 'Digit6'], '^': [54, true, 'Digit6'],
  '7': [55, false, 'Digit7'], '&': [55, true, 'Digit7'],
  '8': [56, false, 'Digit8'], '*': [56, true, 'Digit8'],
  '9': [57, false, 'Digit9'], '(': [57, true, 'Digit9'],
  '0': [48, false, 'Digit0'], ')': [48, true, 'Digit0']
};

const MOD = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, shift: 8 };

function charSpec(ch) {
  if (CHAR_KEYS[ch]) {
    const [vk, shift, code] = CHAR_KEYS[ch];
    return { key: ch, vk, code, text: ch, shift };
  }
  if (/^[a-zA-Z]$/.test(ch)) {
    const upper = ch.toUpperCase();
    return { key: ch, vk: upper.charCodeAt(0), code: 'Key' + upper, text: ch, shift: ch !== ch.toLowerCase() };
  }
  if (ch === '\n' || ch === '\r') return { ...NAMED_KEYS.Enter, key: 'Enter', shift: false };
  if (ch === '\t') return { ...NAMED_KEYS.Tab, key: 'Tab', shift: false };
  // Anything else (accented letters, CJK, emoji) has no US-layout key. Send it
  // as a text-only event rather than inventing a key code.
  return { key: ch, vk: 0, code: '', text: ch, shift: false, textOnly: true };
}

// "Ctrl+Shift+P", "ctrl+c", "Enter", "a". Returns null for anything we cannot
// faithfully produce, so the caller can fail loudly instead of pretending.
function parseKeySpec(spec) {
  const raw = String(spec ?? '').trim();
  if (!raw) return null;
  const parts = raw.split('+').map((p) => p.trim()).filter(Boolean);
  // A literal "+" keypress arrives as a single empty-split; handle it.
  if (!parts.length) return raw === '+' ? { ...charSpec('+'), modifiers: 0 } : null;
  const last = parts.pop();
  let modifiers = 0;
  for (const m of parts) {
    const bit = MOD[m.toLowerCase()];
    if (!bit) return null;
    modifiers |= bit;
  }
  let base = null;
  const named = Object.keys(NAMED_KEYS).find((k) => k.toLowerCase() === last.toLowerCase());
  if (named) base = { ...NAMED_KEYS[named], key: named, shift: false };
  else if (last.length === 1) {
    // "Ctrl+C" means ctrl+c. Only an explicit "Shift+" adds Shift, otherwise a
    // capital letter written inside a chord would silently become Ctrl+Shift+C.
    const hasModifier = modifiers !== 0;
    base = charSpec(hasModifier && /^[a-zA-Z]$/.test(last) ? last.toLowerCase() : last);
    if (hasModifier && /^[a-zA-Z]$/.test(last)) base = { ...base, shift: false };
  }
  else if (last.toLowerCase() === 'space') base = charSpec(' ');
  else if (last.toLowerCase() === 'grave' || last.toLowerCase() === 'backquote') base = charSpec('`');
  else return null;
  if (base.shift) modifiers |= MOD.shift;
  // With a non-shift modifier held, the event carries no inserted text.
  if (modifiers & (MOD.ctrl | MOD.alt | MOD.meta)) base = { ...base, text: '' };
  return { ...base, modifiers };
}

function cdp(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (res) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(res);
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function attachDebugger(tabId) {
  if (!chrome.debugger) throw new Error('chrome.debugger API unavailable');
  if (attachedTabs.has(tabId)) return;
  await new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, '1.3', () => {
      const err = chrome.runtime.lastError;
      if (err && !/already attached/i.test(err.message)) reject(new Error(err.message));
      else resolve();
    });
  });
  attachedTabs.add(tabId);
}

async function detachDebugger(tabId) {
  if (!attachedTabs.has(tabId)) return;
  attachedTabs.delete(tabId);
  await new Promise((resolve) => chrome.debugger.detach({ tabId }, () => { void chrome.runtime.lastError; resolve(); }));
}

async function detachAllDebuggers() {
  for (const id of Array.from(attachedTabs)) await detachDebugger(id);
}

chrome.debugger?.onDetach?.addListener?.((source) => {
  if (source?.tabId != null) attachedTabs.delete(source.tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => attachedTabs.delete(tabId));

// One keystroke: keyDown then keyUp. keyUp must NOT carry `text` — the old code
// sent it on both halves, which some renderers treat as a second character.
async function dispatchSpec(tabId, spec) {
  // `shift` comes from charSpec(), `modifiers` from parseKeySpec(); honour both
  // or shifted characters get typed without Shift held.
  const mods = (spec.modifiers || 0) | (spec.shift ? MOD.shift : 0);
  const common = {
    windowsVirtualKeyCode: spec.vk || 0,
    nativeVirtualKeyCode: spec.vk || 0,
    key: spec.key,
    code: spec.code || '',
    modifiers: mods,
    isKeypad: false
  };
  await cdp(tabId, 'Input.dispatchKeyEvent', {
    ...common,
    type: spec.text ? 'keyDown' : 'rawKeyDown',
    text: spec.text || '',
    unmodifiedText: spec.text || ''
  });
  await cdp(tabId, 'Input.dispatchKeyEvent', { ...common, type: 'keyUp' });
}

async function realKey(tabId, spec) {
  await dispatchSpec(tabId, spec);
}

// Normalised comparison: terminals hard-wrap long lines, so whitespace in the
// echo never matches what we sent.
const squash = (s) => String(s || '').replace(/\s+/g, '');

async function readEcho(tabId) {
  try {
    const r = await sendToContent(tabId, { type: 'echoProbe' });
    return r?.ok ? r : null;
  } catch {
    return null;
  }
}

async function typeBody(tabId, body, delayMs) {
  for (const ch of body) {
    await realKey(tabId, charSpec(ch));
    if (delayMs > 0) await sleep(delayMs);
  }
}

async function doSendKeys(text, submit, opts = {}) {
  const tab = await getFocusTab();
  if (!tab) return { ok: false, error: 'No focus tab' };
  const body = String(text ?? '');
  const enter = { ...NAMED_KEYS.Enter, key: 'Enter', modifiers: 0 };

  try {
    await attachDebugger(tab.id);
  } catch (e) {
    try {
      const r = await sendToContent(tab.id, { type: 'sendKeys', text: body, submit: !!submit });
      return {
        ...r,
        mode: 'synthetic',
        warning: `Real input unavailable (${e.message || e}); fell back to synthetic key events, which terminals and canvas editors usually ignore. Verify before trusting this.`
      };
    } catch (e2) {
      return { ok: false, error: `Real input failed (${e.message || e}); synthetic fallback also failed (${e2.message || e2})` };
    }
  }

  // Type, then READ BACK what landed before committing with Enter. Keystrokes
  // can be dropped by a busy renderer, and running a half-typed shell command
  // is worse than not running one at all.
  const expected = squash(body).slice(-60);
  let delayMs = Number.isFinite(opts.delayMs) ? Math.max(0, Math.min(200, opts.delayMs)) : 15;
  const attempts = [];

  for (let attempt = 1; attempt <= 3; attempt++) {
    const before = await readEcho(tab.id);
    await typeBody(tab.id, body, delayMs);
    await sleep(120);
    const after = await readEcho(tab.id);

    if (!after || after.readable === false) {
      attempts.push({ attempt, delayMs, verified: null });
      if (submit) await realKey(tab.id, enter);
      return {
        ok: true,
        typed: body.length,
        submitted: !!submit,
        mode: 'real',
        verified: null,
        tabId: tab.id,
        note:
          'Could not read this target back, so the typed text is UNVERIFIED — a canvas-rendered terminal (xterm.js with the canvas/WebGL renderer) keeps no text in the DOM. ' +
          'Confirm the effect some other way, e.g. redirect output to a file and read the file, before relying on it.'
      };
    }

    const landed = squash(after.sample);
    const ok = !body || landed.includes(expected);
    attempts.push({ attempt, delayMs, verified: ok });

    if (ok) {
      if (submit) await realKey(tab.id, enter);
      return {
        ok: true,
        typed: body.length,
        submitted: !!submit,
        mode: 'real',
        verified: true,
        attempts: attempts.length,
        tabId: tab.id
      };
    }

    // Wrong text landed. Clear the line and retry more slowly rather than
    // pressing Enter on a corrupted command.
    await realKey(tab.id, { ...charSpec('u'), modifiers: MOD.ctrl, text: '' });
    await sleep(120);
    delayMs = Math.min(200, Math.max(30, delayMs * 3));
  }

  const final = await readEcho(tab.id);
  return {
    ok: false,
    verified: false,
    submitted: false,
    mode: 'real',
    attempts,
    error:
      'The characters that reached the target did not match what was sent, after 3 attempts at increasing delays. Enter was NOT pressed, so no partial command was run.',
    sent: body.slice(0, 200),
    landed: (final?.sample || '').slice(-200),
    hint:
      'Confirm the right element has focus (browser_click it first). If this target is genuinely this lossy, send shorter fragments, or raise delayMs (e.g. 60).'
  };
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function getFocusTab() {
  // Agent's focus tab (stable across user's clicks). Falls back to chrome active.
  if (activeRun?.focusTabId != null) {
    try {
      const t = await chrome.tabs.get(activeRun.focusTabId);
      if (t) return t;
    } catch {}
  }
  return getActiveTab();
}

async function sendToContent(tabId, payload, opts = {}) {
  // Target the active run's focus frame unless the caller pins one.
  //
  // This used to silently retry on frame 0 when the target frame did not
  // answer. That turned "your frame switch failed" into "here is the top
  // document again", so the agent could focus a frame that never existed,
  // keep reading frame 0, see identical snapshots, and loop until it ran out
  // of steps. A failed frame send is now a hard, explicit error.
  const frameId = (opts && typeof opts.frameId === 'number') ? opts.frameId : (activeRun?.focusFrame ?? 0);
  try {
    const r = await chrome.tabs.sendMessage(tabId, payload, { frameId });
    // Stamp the frame that actually served the request so the agent can always
    // verify which document it is looking at.
    if (r && typeof r === 'object' && !Array.isArray(r)) r.frameId = frameId;
    return r;
  } catch (e) {
    const err = new Error(
      `Frame ${frameId} in tab ${tabId} did not respond (${e?.message || e}). ` +
        (frameId === 0
          ? 'The top document may still be loading, or this is a restricted page (chrome://, Web Store, PDF viewer).'
          : 'That frame may never have existed, was removed, or was navigated. ' +
            'Chrome frame ids are arbitrary numbers — never guess them. ' +
            'Call browser_iframes to re-list live frames, then browser_focus_frame with a frameId from that list.')
    );
    err.frameId = frameId;
    throw err;
  }
}

async function ensureContentScript(tabId) {
  // In case a frame hasn't loaded the manifest content script yet (dynamically
  // created frames, about:blank, file: pages). Injecting into allFrames can
  // partially fail on restricted frames; that must not abort the whole call.
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['content/extractor.js']
    });
  } catch (e) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId, frameIds: [activeRun?.focusFrame ?? 0] },
        files: ['content/extractor.js']
      });
    } catch {
      throw e;
    }
  }
}

async function doNavigate(url) {
  const tab = await getFocusTab();
  if (!tab) return { ok: false, error: 'No focus tab' };
  await chrome.tabs.update(tab.id, { url, active: true });
  activeRun.focusFrame = 0; // navigation changes frame tree
  await recordFocus(tab.id, 0);
  await waitForTabComplete(tab.id, 15000).catch(() => {});
  return { ok: true, url, tabId: tab.id };
}

async function doNewTab(url) {
  const tab = await chrome.tabs.create({ url, active: true });
  activeRun.focusFrame = 0;
  await recordFocus(tab.id, 0);
  await waitForTabComplete(tab.id, 15000).catch(() => {});
  return { ok: true, tabId: tab.id, url };
}

async function doSwitchTab(tabId) {
  await chrome.tabs.update(tabId, { active: true });
  activeRun.focusFrame = 0; // reset until we know the new frame tree
  await recordFocus(tabId, 0);
  return { ok: true, tabId };
}

async function doListTabs() {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  return {
    ok: true,
    focusTabId: activeRun?.focusTabId ?? null,
    tabs: tabs.map((t) => ({ id: t.id, title: t.title, url: t.url, active: t.active }))
  };
}

async function doSnapshot() {
  const tab = await getFocusTab();
  if (!tab) return { ok: false, error: 'No focus tab' };
  try {
    const r = await sendToContent(tab.id, { type: 'snapshot' });
    return r || { ok: false, error: 'No response' };
  } catch (e) {
    try {
      await ensureContentScript(tab.id);
      const r = await sendToContent(tab.id, { type: 'snapshot' });
      return r || { ok: false, error: 'No response after inject' };
    } catch (e2) {
      return { ok: false, error: `Cannot access frame ${activeRun?.focusFrame ?? 0}: ${e2.message || e2}` };
    }
  }
}

async function doClick(ref) {
  const tab = await getFocusTab();
  if (!tab) return { ok: false, error: 'No focus tab' };
  try {
    return await sendToContent(tab.id, { type: 'click', ref });
  } catch (e) {
    try {
      await ensureContentScript(tab.id);
      return await sendToContent(tab.id, { type: 'click', ref });
    } catch (e2) {
      return { ok: false, error: String(e2.message || e2) };
    }
  }
}

async function doType(ref, text, submit) {
  const tab = await getFocusTab();
  if (!tab) return { ok: false, error: 'No focus tab' };
  try {
    return await sendToContent(tab.id, { type: 'type', ref, text, submit: !!submit });
  } catch (e) {
    try {
      await ensureContentScript(tab.id);
      return await sendToContent(tab.id, { type: 'type', ref, text, submit: !!submit });
    } catch (e2) {
      return { ok: false, error: String(e2.message || e2) };
    }
  }
}

async function doPressKey(key) {
  const tab = await getFocusTab();
  if (!tab) return { ok: false, error: 'No focus tab' };

  // Previously ANY string was accepted: "ctrl+grave", "Ctrl+C" and "F5" all
  // returned ok:true while dispatching a key code of 0, i.e. nothing at all.
  const spec = parseKeySpec(key);
  if (!spec) {
    return {
      ok: false,
      error: `Unrecognised key "${key}". Nothing was pressed.`,
      validKeys: Object.keys(NAMED_KEYS),
      format: 'A single character ("a", "/"), a named key ("Enter", "F5", "ArrowDown"), or modifiers joined with + ("Ctrl+C", "Ctrl+Shift+P").'
    };
  }

  try {
    await attachDebugger(tab.id);
    await realKey(tab.id, spec);
    return { ok: true, key, resolved: { key: spec.key, code: spec.code, modifiers: spec.modifiers }, mode: 'real', tabId: tab.id };
  } catch {}
  try {
    return await sendToContent(tab.id, { type: 'pressKey', key: spec.key, ctrl: !!(spec.modifiers & 2), shift: !!(spec.modifiers & 8), alt: !!(spec.modifiers & 1), meta: !!(spec.modifiers & 4) });
  } catch (e) {
    try {
      await ensureContentScript(tab.id);
      return await sendToContent(tab.id, { type: 'pressKey', key: spec.key });
    } catch (e2) {
      return { ok: false, error: String(e2.message || e2) };
    }
  }
}

async function doReadTerminal(maxChars) {
  const tab = await getFocusTab();
  if (!tab) return { ok: false, error: 'No focus tab' };
  try {
    const r = await sendToContent(tab.id, { type: 'readTerminal' });
    if (!r) return { ok: false, error: 'No response' };
    if (r.ok && r.text) {
      const max = Math.max(200, Math.min(20000, maxChars || 4000));
      return { ...r, text: r.text.slice(-max), truncatedFromStart: r.text.length > max };
    }
    return r;
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

async function doScroll(direction, amount) {
  const tab = await getFocusTab();
  if (!tab) return { ok: false, error: 'No focus tab' };
  try {
    return await sendToContent(tab.id, { type: 'scroll', direction, amount });
  } catch (e) {
    try {
      await ensureContentScript(tab.id);
      return await sendToContent(tab.id, { type: 'scroll', direction, amount });
    } catch (e2) {
      return { ok: false, error: String(e2.message || e2) };
    }
  }
}

async function doExtract(selector, attr, limit) {
  const tab = await getFocusTab();
  if (!tab) return { ok: false, error: 'No focus tab' };
  try {
    return await sendToContent(tab.id, { type: 'extract', selector, attr, limit });
  } catch (e) {
    try {
      await ensureContentScript(tab.id);
      return await sendToContent(tab.id, { type: 'extract', selector, attr, limit });
    } catch (e2) {
      return { ok: false, error: String(e2.message || e2) };
    }
  }
}

async function doExtractFromTab(tabId, selector, attr, limit, frameId) {
  if (tabId == null) return { ok: false, error: 'tabId required' };
  // Used to hard-code frame 0, so reading a tab whose content lives in an
  // iframe returned the outer shell (often just "enable JavaScript").
  try {
    return await sendToContent(tabId, { type: 'extract', selector, attr, limit }, { frameId: frameId ?? 0 });
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

async function doPageText(tabId, maxChars, frameId, offset) {
  const targetId = tabId ?? (await getFocusTab())?.id;
  if (targetId == null) return { ok: false, error: 'No tab to read' };
  try {
    const r = await sendToContent(targetId, { type: 'extractContent' }, { frameId: frameId ?? activeRun?.focusFrame ?? 0 });
    if (!r || !r.ok) return r || { ok: false, error: 'No response' };
    const max = Math.max(500, Math.min(30000, maxChars || 6000));
    const full = r.content || '';
    const start = Math.max(0, Math.min(full.length, Number(offset) || 0));
    const text = full.slice(start, start + max);
    const usedFrame = frameId ?? activeRun?.focusFrame ?? 0;
    return {
      ok: true,
      tabId: targetId,
      frameId: usedFrame,
      url: r.url,
      title: r.title,
      offset: start,
      returnedChars: text.length,
      totalChars: r.fullLength ?? full.length,
      nextOffset: start + text.length < full.length ? start + text.length : null,
      text,
      ...(start + text.length < full.length
        ? { note2: `More text remains. Call browser_page_text again with offset: ${start + text.length}. Scrolling will NOT change this output — page_text always returns the whole document.` }
        : {}),
      ...(text.trim().length < 40
        ? {
            note:
              `Frame ${usedFrame} has almost no readable text. The real content is likely in another frame — ` +
              `call browser_iframes and switch with browser_focus_frame.`
          }
        : {})
    };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

// Ask every live frame in a tab to describe itself.
//
// The old mapping matched a DOM iframe's `src` ATTRIBUTE against webNavigation
// URLs. Frames that start life at about:blank and are navigated by script —
// which is exactly what LTI/LMS/OAuth embeds do — kept a stale src, so the
// frames that actually mattered always mapped to frameId: null. We now take
// webNavigation as the source of truth and probe each frame directly.
async function describeFrames(tabId) {
  let webFrames = [];
  try {
    webFrames = (await chrome.webNavigation.getAllFrames({ tabId })) || [];
  } catch {}
  if (!webFrames.length) webFrames = [{ frameId: 0, parentFrameId: -1, url: '' }];

  try {
    await ensureContentScript(tabId);
  } catch {}

  const frames = [];
  for (const wf of webFrames) {
    let probe = null;
    try {
      probe = await chrome.tabs.sendMessage(tabId, { type: 'probe' }, { frameId: wf.frameId });
    } catch {}
    frames.push({
      frameId: wf.frameId,
      parentFrameId: wf.parentFrameId,
      depth: frameDepth(webFrames, wf.frameId),
      url: truncate(probe?.url || wf.url || '', 200),
      title: probe?.title ? truncate(probe.title, 120) : null,
      reachable: !!probe?.ok,
      interactiveCount: probe?.interactiveCount ?? null,
      textLength: probe?.textLength ?? null,
      textPreview: probe?.textPreview ? truncate(probe.textPreview, 200) : null,
      childIframes: probe?.iframeCount ?? null
    });
  }
  return frames;
}

function frameDepth(webFrames, frameId) {
  let depth = 0;
  let cur = webFrames.find((f) => f.frameId === frameId);
  const seen = new Set();
  while (cur && cur.parentFrameId != null && cur.parentFrameId >= 0 && !seen.has(cur.frameId)) {
    seen.add(cur.frameId);
    depth += 1;
    cur = webFrames.find((f) => f.frameId === cur.parentFrameId);
  }
  return depth;
}

async function doListIframes() {
  const tab = await getFocusTab();
  if (!tab) return { ok: false, error: 'No focus tab' };

  const frames = await describeFrames(tab.id);

  // DOM-level <iframe> tags from the CURRENT focus frame, for extra context
  // (title/name/size) — useful but never the source of frameId.
  let domIframes = [];
  try {
    const r = await sendToContent(tab.id, { type: 'listIframes' });
    if (r?.ok) domIframes = r.iframes || [];
  } catch {}

  const reachable = frames.filter((f) => f.reachable && f.frameId !== 0);
  const suggestion = reachable
    .slice()
    .sort((a, b) => (b.interactiveCount || 0) - (a.interactiveCount || 0))[0];

  return {
    ok: true,
    focusTabId: tab.id,
    focusFrame: activeRun?.focusFrame ?? 0,
    frameCount: frames.length,
    frames,
    domIframesInFocusFrame: domIframes,
    suggestedFrameId: suggestion ? suggestion.frameId : null,
    hint:
      'frameId values here are real Chrome frame ids and are arbitrary numbers — pass one verbatim to browser_focus_frame. ' +
      'Prefer a frame with reachable:true and a high interactiveCount or a meaningful textPreview. ' +
      'reachable:false means the extension cannot script that frame (sandboxed or restricted); ' +
      'for those, open the frame url in a tab with browser_new_tab instead.'
  };
}

async function doFocusFrame(frameId) {
  if (!activeRun) return { ok: false, error: 'No active agent run' };
  if (typeof frameId !== 'number' || !Number.isInteger(frameId) || frameId < 0) {
    return { ok: false, error: 'frameId must be a non-negative integer (0 = top document)' };
  }
  const tab = await getFocusTab();
  if (!tab) return { ok: false, error: 'No focus tab' };

  // Validate against the real frame tree. Previously ANY integer was accepted,
  // so a guessed frameId "succeeded" and every later action silently fell back
  // to the top document.
  let webFrames = [];
  try {
    webFrames = (await chrome.webNavigation.getAllFrames({ tabId: tab.id })) || [];
  } catch {}

  if (webFrames.length && !webFrames.some((f) => f.frameId === frameId)) {
    return {
      ok: false,
      error:
        `Frame ${frameId} does not exist in tab ${tab.id}. Focus unchanged (still frame ${activeRun.focusFrame ?? 0}). ` +
        'Chrome frame ids are arbitrary numbers, not 0,1,2 — do not guess them. Call browser_iframes first.',
      validFrameIds: webFrames.map((f) => f.frameId),
      focusFrame: activeRun.focusFrame ?? 0
    };
  }

  // Confirm the frame can actually be scripted before committing the switch.
  let probe = null;
  try {
    probe = await chrome.tabs.sendMessage(tab.id, { type: 'probe' }, { frameId });
  } catch {
    try {
      await ensureContentScript(tab.id);
      probe = await chrome.tabs.sendMessage(tab.id, { type: 'probe' }, { frameId });
    } catch {}
  }

  if (!probe?.ok) {
    return {
      ok: false,
      error:
        `Frame ${frameId} exists but cannot be scripted (sandboxed, restricted, or still loading). ` +
        `Focus unchanged (still frame ${activeRun.focusFrame ?? 0}). ` +
        'Try browser_wait then retry, pick another frame from browser_iframes, or open its url with browser_new_tab.',
      focusFrame: activeRun.focusFrame ?? 0
    };
  }

  activeRun.focusFrame = frameId;
  broadcast({
    type: 'agent:focus',
    tabId: tab.id,
    frameId,
    url: probe.url || tab.url,
    title: probe.title || tab.title,
    history: activeRun.focusHistory || []
  });
  return {
    ok: true,
    frameId,
    focusTabId: tab.id,
    url: truncate(probe.url || '', 200),
    title: truncate(probe.title || '', 120),
    interactiveCount: probe.interactiveCount,
    textPreview: truncate(probe.textPreview || '', 200)
  };
}

async function doClickText(text, exact) {
  const tab = await getFocusTab();
  if (!tab) return { ok: false, error: 'No focus tab' };
  try {
    return await sendToContent(tab.id, { type: 'clickByText', text, exact: !!exact });
  } catch (e) {
    try {
      await ensureContentScript(tab.id);
      return await sendToContent(tab.id, { type: 'clickByText', text, exact: !!exact });
    } catch (e2) {
      return { ok: false, error: String(e2.message || e2) };
    }
  }
}

async function waitForTabComplete(tabId, timeoutMs) {
  // If the tab already finished loading before we attached the listener, the
  // 'complete' event never fires again and this used to block for the full
  // timeout on every navigation to a cached page.
  try {
    const t = await chrome.tabs.get(tabId);
    if (t?.status === 'complete') return;
  } catch {}
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Tab load timeout'));
    }, timeoutMs);
    function listener(updatedId, info) {
      if (updatedId === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timer);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}