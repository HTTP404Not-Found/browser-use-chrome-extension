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
          maxContextChars: 80000
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

const MAX_AGENT_STEPS = 25;

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
      if (activeRun.step > MAX_AGENT_STEPS) {
        broadcast({ type: 'error', message: `Agent hit max steps (${MAX_AGENT_STEPS}).` });
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
    case 'browser_scroll':
      return doScroll(args.direction, args.amount);
    case 'browser_extract':
      return doExtract(args.selector, args.attr, args.limit);
    case 'browser_extract_from_tab':
      return doExtractFromTab(args.tabId, args.selector, args.attr, args.limit);
    case 'browser_page_text':
      return doPageText(args.tabId, args.maxChars);
    case 'browser_iframes':
      return doListIframes();
    case 'browser_focus_frame':
      return doFocusFrame(args.frameId);
    case 'browser_click_text':
      return doClickText(args.text, args.exact);
    case 'browser_wait': {
      const ms = Math.max(0, Math.min(5000, args.ms || 0));
      await new Promise((r) => setTimeout(r, ms));
      return { ok: true, waited: ms };
    }
    case 'browser_done':
      return { ok: true, result: args.result || '' };
    case 'browser_ask_user':
      return { ok: true, question: args.question || '' };
    default:
      return { ok: false, error: 'unhandled' };
  }
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
  // Default to the active run's focus frame; fall back to top frame.
  const frameId = (opts && typeof opts.frameId === 'number')
    ? opts.frameId
    : (activeRun?.focusFrame ?? 0);
  try {
    return await chrome.tabs.sendMessage(tabId, payload, { frameId });
  } catch (e) {
    // Frame might have disappeared; if it wasn't the top frame, retry on top.
    if (frameId !== 0) {
      try {
        return await chrome.tabs.sendMessage(tabId, payload, { frameId: 0 });
      } catch (e2) {
        throw e; // surface the original frame error
      }
    }
    throw e;
  }
}

async function ensureContentScript(tabId) {
  // In case the page hasn't loaded the manifest content script yet
  // (rare — usually only for dynamically opened about: or file: pages).
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ['content/extractor.js']
  });
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
  try {
    return await sendToContent(tab.id, { type: 'pressKey', key });
  } catch (e) {
    try {
      await ensureContentScript(tab.id);
      return await sendToContent(tab.id, { type: 'pressKey', key });
    } catch (e2) {
      return { ok: false, error: String(e2.message || e2) };
    }
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

async function doExtractFromTab(tabId, selector, attr, limit) {
  if (tabId == null) return { ok: false, error: 'tabId required' };
  try {
    return await sendToContent(tabId, { type: 'extract', selector, attr, limit }, { frameId: 0 });
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

async function doPageText(tabId, maxChars, frameId) {
  const targetId = tabId ?? (await getFocusTab())?.id;
  if (targetId == null) return { ok: false, error: 'No tab to read' };
  try {
    const r = await sendToContent(targetId, { type: 'extractContent' }, { frameId: frameId ?? activeRun?.focusFrame ?? 0 });
    if (!r || !r.ok) return r || { ok: false, error: 'No response' };
    const max = Math.max(500, Math.min(30000, maxChars || 6000));
    return {
      ok: true,
      tabId: targetId,
      frameId: frameId ?? activeRun?.focusFrame ?? 0,
      url: r.url,
      title: r.title,
      text: (r.content || '').slice(0, max)
    };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

async function doListIframes() {
  const tab = await getFocusTab();
  if (!tab) return { ok: false, error: 'No focus tab' };
  // Get DOM-side iframe list AND frameId mapping from webNavigation.
  let domIframes = [];
  try {
    const r = await sendToContent(tab.id, { type: 'listIframes' });
    if (r?.ok) domIframes = r.iframes || [];
  } catch (e) {
    try {
      await ensureContentScript(tab.id);
      const r = await sendToContent(tab.id, { type: 'listIframes' });
      if (r?.ok) domIframes = r.iframes || [];
    } catch {}
  }
  let webFrames = [];
  try {
    webFrames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
  } catch {}
  // Map DOM iframe index to webNavigation frameId by walking the frame tree.
  // Simpler heuristic: match frame URL starts with the iframe src.
  const enriched = domIframes.map((f, idx) => {
    let matchedFrameId = null;
    if (webFrames.length) {
      const norm = (u) => (u || '').split('#')[0];
      const target = norm(f.src);
      for (const wf of webFrames) {
        if (wf.frameId === 0) continue;
        if (norm(wf.url) === target || norm(wf.url).startsWith(target.split('?')[0])) {
          matchedFrameId = wf.frameId;
          break;
        }
      }
    }
    return { ...f, frameId: matchedFrameId };
  });
  return {
    ok: true,
    focusTabId: activeRun?.focusTabId ?? null,
    focusFrame: activeRun?.focusFrame ?? 0,
    iframes: enriched,
    frameCount: webFrames.length
  };
}

async function doFocusFrame(frameId) {
  if (typeof frameId !== 'number') return { ok: false, error: 'frameId must be a number (0 = top)' };
  activeRun.focusFrame = frameId;
  // Broadcast so the side panel can reflect the change
  const tab = activeRun.focusTabId ? await chrome.tabs.get(activeRun.focusTabId).catch(() => null) : null;
  broadcast({ type: 'agent:focus', tabId: activeRun.focusTabId, frameId, url: tab?.url, title: tab?.title, history: activeRun.focusHistory || [] });
  return { ok: true, frameId, focusTabId: activeRun.focusTabId };
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

function waitForTabComplete(tabId, timeoutMs) {
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