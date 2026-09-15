// background.js (service worker, MV3, ES module)
// Orchestrates:
//   1. Side panel open on action click
//   2. Chat streaming via SSE
//   3. Browser-use agent loop (plan → execute → observe)
//   4. Tab/navigation actions
//
// Runs are scoped per tab. Every tab can own one chat run and one agent run,
// and runs in different tabs execute in parallel: starting a task in tab B no
// longer aborts the agent working in tab A. An agent run "owns" the tab it was
// started from plus every tab it opens or switches to; other runs are refused
// access to those tabs so two agents never type into the same page.
//
// The side panel connects via chrome.runtime.connect('bu-stream'). Run events
// carry ownerTabId + runKind so each panel shows only the run for the tab it
// is looking at, and agent runs keep an event log the panel replays when the
// user switches back to that tab.

import { streamChat, getLlmConfig } from './lib/llm.js';
import { BROWSER_TOOLS, TOOL_NAME_SET } from './lib/tools.js';
import { CHAT_SYSTEM_PROMPT, AGENT_SYSTEM_PROMPT, buildPageContextMessage } from './lib/prompts.js';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

// maxSteps is overridable from the options page; 0 or Infinity means
// "unlimited". The agent stops naturally when it calls browser_done, when it
// asks the user a question, or when it is aborted.
const DEFAULT_MAX_AGENT_STEPS = Infinity;
const MAX_WAIT_MS = 30000;
// A single tool result stored in the conversation.
const TOOL_RESULT_MAX_CHARS = 12000;
// Older tool results are collapsed to a one-line summary before each LLM call.
// Without this every step re-sent every snapshot and page dump since the start
// of the run, so late steps carried 100k+ tokens of stale observations.
const KEEP_FULL_TOOL_RESULTS = 6;
const KEEP_REASONING_TURNS = 3;
// Events kept per agent run so the panel can replay a tab's run.
const RUN_LOG_MAX = 400;
// Default time send_keys waits for a shell prompt to come back after Enter.
const DEFAULT_COMMAND_WAIT_MS = 8000;

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
      try { port.postMessage({ type: 'error', message: String(e?.message || e) }); } catch {}
    });
  });
});

// One-shot requests from the side panel. The panel always used
// chrome.runtime.sendMessage for 'chat:load', but nothing listened for it, so
// switching tabs silently rendered an empty thread.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender?.tab) return; // content scripts never message the background
  if (msg?.type !== 'chat:load' && msg?.type !== 'panel:load') return;
  chatStoreReady.then(() => {
    const tabId = msg.tabId;
    if (msg.type === 'chat:load') {
      const chat = tabId != null ? chatByTabId.get(tabId) : null;
      sendResponse({ tabId, messages: chat ? chat.messages : [] });
    } else {
      sendResponse(panelState(tabId));
    }
  });
  return true; // async
});

// ---------------------------------------------------------------------------
// Run registries
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} AgentRun
 * @property {'agent'} kind
 * @property {number} ownerTabId      // tab the task was started from
 * @property {string} ownerTitle
 * @property {Array} messages
 * @property {AbortController} abort
 * @property {number} step
 * @property {boolean} finished
 * @property {boolean} awaitingUser
 * @property {string|null} awaitingQuestion
 * @property {number|null} focusTabId  // the tab the agent is acting on
 * @property {number} focusFrame       // frame within that tab (0 = top)
 * @property {Array} focusHistory      // [{ tabId, url, title }] for breadcrumb
 * @property {Set<number>} ownedTabs   // tabs this run may drive
 * @property {Set<number>} debugTabs   // tabs this run attached the debugger to
 * @property {Array} log               // events replayed by the panel
 */

/** @type {Map<number, AgentRun>} ownerTabId -> active or most recent run */
const agentRuns = new Map();
/** @type {Map<number, Object>} tabId -> most recent chat run */
const chatRuns = new Map();

function emit(run, evt) {
  const full = { ...evt, ownerTabId: run.ownerTabId, runKind: run.kind };
  if (run.kind === 'agent') appendRunLog(run, full);
  broadcast(full);
}

function appendRunLog(run, evt) {
  if (evt.type === 'reasoning') return;
  const log = run.log;
  if (evt.type === 'token') {
    const last = log[log.length - 1];
    if (last && last.type === 'token') last.content += evt.content;
    else log.push({ ...evt });
  } else if (evt.type === 'agent:toolResult') {
    log.push({ ...evt, observation: clipForLog(evt.observation) });
  } else {
    log.push(evt);
  }
  if (log.length > RUN_LOG_MAX) log.splice(0, log.length - RUN_LOG_MAX);
}

function clipForLog(obs) {
  let s;
  try { s = JSON.stringify(obs); } catch { return obs; }
  if (!s || s.length <= 3000) return obs;
  return { preview: s.slice(0, 2000) + '…', truncatedChars: s.length };
}

function describeRun(run) {
  if (!run) return null;
  return {
    ownerTabId: run.ownerTabId,
    ownerTitle: run.ownerTitle,
    kind: run.kind,
    step: run.step,
    finished: run.finished,
    awaitingUser: run.awaitingUser,
    awaitingQuestion: run.awaitingQuestion,
    focusTabId: run.focusTabId ?? null,
    focusFrame: run.focusFrame ?? 0,
    focusHistory: run.focusHistory ?? []
  };
}

function activeRunSummaries() {
  return Array.from(agentRuns.values())
    .filter((r) => !r.finished)
    .map((r) => ({ ownerTabId: r.ownerTabId, title: r.ownerTitle, awaitingUser: r.awaitingUser }));
}

function broadcastRuns() {
  broadcast({ type: 'runs:changed', runs: activeRunSummaries() });
}

// The run the panel should show for a tab: an active run that owns or drives
// the tab, else the most recent finished run started from it.
function agentRunForTab(tabId) {
  if (tabId == null) return null;
  const own = agentRuns.get(tabId);
  if (own && !own.finished) return own;
  for (const r of agentRuns.values()) {
    if (!r.finished && r.ownedTabs.has(tabId)) return r;
  }
  return own || null;
}

// Another active run that is driving this tab, if any.
function tabOwnerConflict(tabId, exceptRun) {
  for (const r of agentRuns.values()) {
    if (r !== exceptRun && !r.finished && r.ownedTabs.has(tabId)) return r;
  }
  return null;
}

function panelState(tabId) {
  const chat = tabId != null ? chatByTabId.get(tabId) : null;
  const run = agentRunForTab(tabId);
  return {
    tabId,
    messages: chat ? chat.messages : [],
    agent: run ? { run: describeRun(run), log: run.log } : null,
    runs: activeRunSummaries()
  };
}

// ---------------------------------------------------------------------------
// Per-tab chat store
// ---------------------------------------------------------------------------
// Every open tab owns its own chat thread. Switching tabs shows that tab's
// history; navigating to a fresh page within a tab keeps the same thread so
// the user can continue asking follow-up questions; clicking the "+" button
// clears only the current tab's thread. The store lives in chrome.storage.session
// so it survives SW restarts but is wiped when the browser closes.

/** @type {Map<number, { messages: Array, updatedAt: number }>} */
let chatByTabId = new Map();

async function loadChatStore() {
  try {
    const r = await chrome.storage.session?.get?.(['chatByTabId']);
    if (r && r.chatByTabId && typeof r.chatByTabId === 'object') {
      chatByTabId = new Map(
        Object.entries(r.chatByTabId)
          .map(([k, v]) => [Number(k), { messages: Array.isArray(v?.messages) ? v.messages : [], updatedAt: v?.updatedAt || 0 }])
          .filter(([k]) => Number.isFinite(k))
      );
    }
  } catch {}
}

let persistTimer = null;
function persistChatStore() {
  // Debounce so a streaming run doesn't hammer storage on every token.
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      const obj = Object.fromEntries(chatByTabId);
      chrome.storage.session?.set?.({ chatByTabId: obj });
    } catch {}
  }, 250);
}

function getOrCreateChat(tabId) {
  if (!chatByTabId.has(tabId)) chatByTabId.set(tabId, { messages: [], updatedAt: Date.now() });
  return chatByTabId.get(tabId);
}

function broadcastChat(tabId) {
  const chat = chatByTabId.get(tabId);
  broadcast({ type: 'chat:updated', tabId, messages: chat ? chat.messages : [] });
}

// On startup, restore prior chat history. SWs are restarted frequently in MV3,
// but chrome.storage.session survives.
const chatStoreReady = loadChatStore();

// chrome.tabs.onActivated -> notify side panels so they can swap the visible
// thread. windowId lets a panel ignore tab switches in other windows.
chrome.tabs?.onActivated?.addListener?.((activeInfo) => {
  broadcast({ type: 'tab:activated', tabId: activeInfo.tabId, windowId: activeInfo.windowId });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  attachedTabs.delete(tabId);
  for (const [key, cm] of inputModeCache) if (key.startsWith(`${tabId}:`)) inputModeCache.delete(key);
  if (chatByTabId.has(tabId)) {
    chatByTabId.delete(tabId);
    persistChatStore();
  }
  const chatRun = chatRuns.get(tabId);
  if (chatRun) {
    if (!chatRun.finished) chatRun.abort.abort();
    chatRuns.delete(tabId);
  }
  const own = agentRuns.get(tabId);
  if (own) {
    // A run keeps working on its other tabs after its owner tab closes; it is
    // forgotten once it finishes.
    if (own.finished) agentRuns.delete(tabId);
    else own.ownerClosed = true;
  }
  for (const r of agentRuns.values()) {
    if (r.ownerTabId !== tabId) r.ownedTabs.delete(tabId);
  }
  broadcast({ type: 'tab:closed', tabId });
});

async function handleClientMessage(msg, port) {
  switch (msg.type) {
    case 'hello':
      port.postMessage({ type: 'hello-ack', runs: activeRunSummaries() });
      return;
    case 'chat:send': {
      const { userText, page, tabId } = msg;
      if (tabId == null) {
        port.postMessage({ type: 'error', message: 'chat:send needs a tabId' });
        return;
      }
      await chatStoreReady;
      const chat = getOrCreateChat(tabId);
      // Persist the user message immediately so a quick refresh / SW restart
      // doesn't drop it.
      chat.messages.push({ role: 'user', content: userText });
      chat.updatedAt = Date.now();
      persistChatStore();
      broadcastChat(tabId);
      const messages = [{ role: 'system', content: CHAT_SYSTEM_PROMPT }];
      const ctx = buildPageContextMessage(page);
      if (ctx) messages.push(ctx);
      // Carry forward the prior conversation (excluding the brand-new user msg
      // we just appended, since we add it again below to keep ordering exact).
      for (let i = 0; i < chat.messages.length - 1; i++) messages.push(chat.messages[i]);
      messages.push({ role: 'user', content: userText });
      return startChat(messages, tabId, chat);
    }
    case 'chat:regenerate': {
      const { tabId } = msg;
      const prev = tabId != null ? chatRuns.get(tabId) : null;
      if (!prev) return;
      if (!prev.finished) prev.abort.abort();
      const chat = chatByTabId.get(tabId);
      // Drop the last assistant message from both the LLM context and the
      // persisted store, then retry.
      const m = prev.messages.slice();
      while (m.length && m[m.length - 1].role === 'assistant') m.pop();
      if (chat) {
        while (chat.messages.length && chat.messages[chat.messages.length - 1].role === 'assistant') chat.messages.pop();
        chat.updatedAt = Date.now();
        persistChatStore();
        broadcastChat(tabId);
      }
      return startChat(m, tabId, chat || null);
    }
    case 'chat:clear': {
      const { tabId } = msg;
      if (tabId == null) return;
      chatByTabId.delete(tabId);
      persistChatStore();
      broadcast({ type: 'chat:updated', tabId, messages: [] });
      return;
    }
    case 'agent:start': {
      const { task, page } = msg;
      const ownerTabId = msg.tabId ?? (await getActiveTab())?.id ?? null;
      if (ownerTabId == null) {
        port.postMessage({ type: 'error', message: 'No tab to run the agent in.' });
        return;
      }
      const busy = tabOwnerConflict(ownerTabId, null);
      if (busy) {
        port.postMessage({
          type: 'error',
          message:
            busy.ownerTabId === ownerTabId
              ? 'An agent is already running in this tab. Press Stop first, or start the new task from another tab.'
              : `This tab is being driven by the agent started from tab ${busy.ownerTabId}. Start the new task from another tab.`
        });
        return;
      }
      let ownerTab = null;
      try { ownerTab = await chrome.tabs.get(ownerTabId); } catch {}
      const tabs = ownerTab ? await chrome.tabs.query({ windowId: ownerTab.windowId }) : [];
      const tabList = tabs
        .map((t) => {
          const other = tabOwnerConflict(t.id, null);
          const flags = [t.id === ownerTabId ? 'your start tab' : '', other ? 'busy: another agent' : ''].filter(Boolean).join(', ');
          return `  - tab ${t.id}${flags ? ` (${flags})` : ''}: ${truncate(t.title || t.url || '', 80)}`;
        })
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
            `Your focus tab starts at tab ${ownerTabId}. ` +
            `Use browser_tabs any time you need to check the tab landscape. ` +
            `Use browser_switch_tab to change focus, browser_new_tab to open more, ` +
            `and browser_extract_from_tab or browser_page_text to read a tab without disturbing the user.`
        }
      ];
      return startAgent(messages, ownerTabId, ownerTab?.title || ownerTab?.url || '');
    }
    case 'agent:userReply': {
      const run = agentRuns.get(msg.ownerTabId);
      if (!run || run.finished || !run.awaitingUser) return;
      run.awaitingUser = false;
      const question = run.awaitingQuestion;
      run.awaitingQuestion = null;
      emit(run, { type: 'agent:userReplied', text: msg.text });
      broadcastRuns();
      run.messages.push({
        role: 'user',
        content: `User reply: ${msg.text}\n(Original question you asked: ${question})`
      });
      return resumeAgent(run);
    }
    case 'agent:clear': {
      const run = agentRuns.get(msg.ownerTabId);
      if (run && run.finished) agentRuns.delete(msg.ownerTabId);
      return;
    }
    case 'abort': {
      const run = agentRuns.get(msg.ownerTabId);
      if (run && !run.finished) {
        run.abort.abort();
        // A run paused on browser_ask_user has no loop left to notice the abort.
        if (run.awaitingUser) await finishAgentRun(run, { error: true, aborted: true });
      }
      return;
    }
  }
}

function truncate(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n) + '…' : s;
}

async function recordFocus(run, tabId, frameId) {
  if (!run || tabId == null) return;
  run.focusTabId = tabId;
  run.ownedTabs.add(tabId);
  if (typeof frameId === 'number') run.focusFrame = frameId;
  try {
    const t = await chrome.tabs.get(tabId);
    run.focusHistory = (run.focusHistory || []).concat([{ tabId, url: t.url, title: t.title }]).slice(-10);
    emit(run, { type: 'agent:focus', tabId, frameId: run.focusFrame ?? 0, url: t.url, title: t.title, history: run.focusHistory });
  } catch {
    emit(run, { type: 'agent:focus', tabId, frameId: run.focusFrame ?? 0 });
  }
}

// ---------------------------------------------------------------------------
// Chat run (single LLM turn, streaming)
// ---------------------------------------------------------------------------

async function startChat(messages, tabId, chat) {
  const prev = chatRuns.get(tabId);
  if (prev && !prev.finished) prev.abort.abort();
  const run = {
    kind: 'chat',
    ownerTabId: tabId,
    messages,
    abort: new AbortController(),
    chatStore: chat || null,
    finished: false
  };
  chatRuns.set(tabId, run);
  emit(run, { type: 'run:start', kind: 'chat' });
  await runChatOnce(run);
}

async function runChatOnce(run) {
  try {
    const final = await streamChat({
      messages: run.messages,
      signal: run.abort.signal,
      onDelta: (content) => emit(run, { type: 'token', content }),
      onReasoningDelta: (content) => emit(run, { type: 'reasoning', content }),
      onDone: (finalMsg) => {
        run.messages.push(finalMsg);
        // Mirror the assistant reply into the per-tab chat store so it
        // survives SW restart and is visible when the user comes back to
        // this tab.
        if (run.chatStore) {
          run.chatStore.messages.push(finalMsg);
          run.chatStore.updatedAt = Date.now();
          persistChatStore();
          broadcastChat(run.ownerTabId);
        }
      }
    });
    run.finished = true;
    emit(run, { type: 'run:end', kind: 'chat', finalMessage: final });
  } catch (e) {
    run.finished = true;
    // A chat replaced by a newer one in the same tab ends quietly.
    if (chatRuns.get(run.ownerTabId) !== run) return;
    if (!run.abort.signal.aborted) emit(run, { type: 'error', message: String(e?.message || e) });
    emit(run, { type: 'run:end', kind: 'chat', error: true });
  }
}

// ---------------------------------------------------------------------------
// Agent run (loop with tool execution)
// ---------------------------------------------------------------------------

async function getMaxAgentSteps() {
  try {
    const cfg = await getLlmConfig();
    const n = Number(cfg?.maxSteps);
    // 0 / negative / non-finite / missing -> unlimited. Anything >= 1 is taken
    // verbatim with no upper cap (options.js is the UI's clamp; the runtime
    // trusts the user-chosen value).
    if (!Number.isFinite(n) || n <= 0) return Infinity;
    return Math.floor(n);
  } catch {}
  return DEFAULT_MAX_AGENT_STEPS;
}

async function startAgent(messages, ownerTabId, ownerTitle) {
  const run = {
    kind: 'agent',
    ownerTabId,
    ownerTitle: truncate(ownerTitle, 80),
    messages,
    abort: new AbortController(),
    step: 0,
    finished: false,
    awaitingUser: false,
    awaitingQuestion: null,
    focusTabId: ownerTabId,
    focusFrame: 0,
    focusHistory: [],
    ownedTabs: new Set([ownerTabId]),
    debugTabs: new Set(),
    recentCalls: [],
    charKeyStreak: 0,
    terminalFailures: 0,
    ownerClosed: false,
    log: []
  };
  agentRuns.set(ownerTabId, run);
  emit(run, { type: 'run:start', kind: 'agent' });
  const firstUser = messages.find((m) => m.role === 'user');
  const task = /^Task: ([\s\S]*?)\n\n/.exec(firstUser?.content || '')?.[1] || '';
  emit(run, { type: 'agent:task', task });
  broadcastRuns();
  await recordFocus(run, ownerTabId, 0);
  return resumeAgent(run);
}

async function finishAgentRun(run, endEvt) {
  if (run.finished) return;
  run.finished = true;
  run.awaitingUser = false;
  emit(run, { type: 'run:end', kind: 'agent', ...endEvt });
  broadcastRuns();
  await detachRunDebuggers(run);
  if (run.ownerClosed && agentRuns.get(run.ownerTabId) === run) agentRuns.delete(run.ownerTabId);
}

async function resumeAgent(run) {
  try {
    while (!run.finished && !run.abort.signal.aborted) {
      if (run.awaitingUser) return; // paused
      run.step += 1;
      const maxSteps = await getMaxAgentSteps();
      if (maxSteps !== Infinity && run.step > maxSteps) {
        emit(run, {
          type: 'error',
          message:
            `Agent hit max steps (${maxSteps}). Raise "maxSteps" in the extension options (set to 0 for unlimited), ` +
            `or give a narrower task. If the run was repeating the same action, the page state was probably not changing.`
        });
        await finishAgentRun(run, { error: true });
        return;
      }
      emit(run, { type: 'agent:step', step: run.step });
      const final = await streamChat({
        messages: buildLlmMessages(run.messages),
        tools: BROWSER_TOOLS,
        toolChoice: 'auto',
        signal: run.abort.signal,
        onDelta: (content) => emit(run, { type: 'token', content }),
        onReasoningDelta: (content) => emit(run, { type: 'reasoning', content }),
        onDone: (finalMsg) => {
          run.messages.push(finalMsg);
        }
      });

      const toolCalls = final.tool_calls;
      if (!toolCalls || toolCalls.length === 0) {
        // Plain text answer. End the run.
        await finishAgentRun(run, { finalMessage: final });
        return;
      }

      // Execute tool calls sequentially.
      const toolResults = [];
      for (let i = 0; i < toolCalls.length; i++) {
        const tc = toolCalls[i];
        if (run.abort.signal.aborted) break;
        const name = tc.function?.name;
        let args = {};
        let argsError = null;
        try {
          args = JSON.parse(tc.function?.arguments || '{}') || {};
        } catch (e) {
          argsError = `Tool arguments were not valid JSON (${e.message}). Nothing was executed.`;
        }
        emit(run, { type: 'agent:toolCall', name, args });
        let observation;
        try {
          observation = argsError ? { ok: false, error: argsError } : await executeTool(run, name, args);
        } catch (e) {
          observation = { ok: false, error: String(e?.message || e) };
        }
        if (!observation || typeof observation !== 'object') observation = { ok: false, error: 'No result' };
        applyLoopGuard(run, name, args, observation);
        emit(run, { type: 'agent:toolResult', name, observation });
        toolResults.push({ role: 'tool', tool_call_id: tc.id, name, content: clipToolContent(observation) });

        // Special tools that pause/end the loop. Any calls the model batched
        // after them still need a tool message, or the next request is invalid.
        if (name === 'browser_done' || name === 'browser_ask_user') {
          for (const rest of toolCalls.slice(i + 1)) {
            toolResults.push({
              role: 'tool',
              tool_call_id: rest.id,
              name: rest.function?.name,
              content: JSON.stringify({ ok: false, error: `Skipped: ${name} was called first.` })
            });
          }
          run.messages.push(...toolResults);
          if (name === 'browser_done') {
            await finishAgentRun(run, { finalMessage: { role: 'assistant', content: observation.result || final.content } });
          } else {
            run.awaitingUser = true;
            run.awaitingQuestion = args.question || '(no question)';
            emit(run, { type: 'agent:awaitingUser', question: run.awaitingQuestion });
            broadcastRuns();
          }
          return;
        }
      }
      run.messages.push(...toolResults);
    }
    if (!run.finished && run.abort.signal.aborted) await finishAgentRun(run, { error: true, aborted: true });
  } catch (e) {
    if (run.finished) return;
    const aborted = run.abort.signal.aborted;
    if (!aborted) emit(run, { type: 'error', message: String(e?.message || e) });
    await finishAgentRun(run, { error: true, aborted });
  }
}

function clipToolContent(observation) {
  let s;
  try { s = JSON.stringify(observation); } catch { s = String(observation); }
  return s.length > TOOL_RESULT_MAX_CHARS ? s.slice(0, TOOL_RESULT_MAX_CHARS) + '…[truncated]' : s;
}

// Build the message list for one LLM call without mutating the run history.
// Recent observations stay verbatim; older ones become short summaries so the
// request size stays roughly flat instead of growing with every step. The
// summary for a given message never changes once made, so provider prefix
// caching still covers everything except the last few steps.
function buildLlmMessages(messages) {
  const out = new Array(messages.length);
  let toolsSeen = 0;
  let assistantsSeen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'tool') {
      toolsSeen += 1;
      out[i] = toolsSeen > KEEP_FULL_TOOL_RESULTS ? { ...m, content: summarizeOldToolContent(m.content) } : m;
    } else if (m.role === 'assistant') {
      assistantsSeen += 1;
      let next = m;
      if (assistantsSeen > KEEP_REASONING_TURNS && next.reasoning_content) {
        next = { ...next };
        delete next.reasoning_content;
      }
      if (assistantsSeen > KEEP_FULL_TOOL_RESULTS && Array.isArray(next.tool_calls)) {
        next = { ...next, tool_calls: next.tool_calls.map(shrinkToolCall) };
      }
      out[i] = next;
    } else {
      out[i] = m;
    }
  }
  return out;
}

function summarizeOldToolContent(content) {
  const s = String(content || '');
  if (s.length <= 400) return s;
  let head;
  try {
    const o = JSON.parse(s);
    const keep = {};
    for (const k of ['ok', 'error', 'url', 'title', 'frameId', 'tabId', 'verified', 'submitted', 'finished', 'mode', 'result']) {
      if (o[k] !== undefined) keep[k] = typeof o[k] === 'string' ? truncate(o[k], 160) : o[k];
    }
    if (typeof o.output === 'string' && o.output) keep.outputTail = o.output.slice(-200);
    head = JSON.stringify(keep);
  } catch {
    head = s.slice(0, 200);
  }
  return `${head} [older result, ${s.length} chars elided — call the tool again if you need it]`;
}

function shrinkToolCall(tc) {
  const a = tc?.function?.arguments;
  if (typeof a !== 'string' || a.length <= 600) return tc;
  return {
    ...tc,
    function: { ...tc.function, arguments: JSON.stringify({ _elided: `${a.length} chars`, preview: a.slice(0, 200) }) }
  };
}

// Loop guard: the same call with the same stable outcome three times within
// the last eight calls means the approach is not working. browser_wait is
// excluded — interleaving waits with key presses used to trip the guard on
// every other step and bury real warnings in noise.
const LOOP_GUARD_IGNORE = new Set(['browser_wait', 'browser_done', 'browser_ask_user']);

function applyLoopGuard(run, name, args, observation) {
  if (LOOP_GUARD_IGNORE.has(name)) return;
  const stableObs = {
    ok: observation.ok,
    error: observation.error,
    hint: observation.hint,
    mode: observation.mode,
    verified: observation.verified,
    finished: observation.finished,
    readable: observation.readable,
    renderer: observation.renderer,
    note: observation.note
  };
  const sig = name + '|' + JSON.stringify(args) + '|' + JSON.stringify(stableObs);
  run.recentCalls = (run.recentCalls || []).concat([sig]).slice(-8);
  const repeats = run.recentCalls.filter((x) => x === sig).length;
  if (repeats >= 3) {
    observation.loopWarning =
      `You have now made this exact call ${repeats} times and received the same result each time. ` +
      'Repeating it again will not change anything. Change approach — call browser_focus_terminal before browser_send_keys on a terminal, ' +
      'call browser_iframes if a control is missing, or call browser_ask_user to get help.';
  }
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

async function executeTool(run, name, args) {
  if (!TOOL_NAME_SET.has(name)) return { ok: false, error: `Unknown tool ${name}` };

  const refused = charByCharGuard(run, name, args);
  if (refused) return refused;

  switch (name) {
    case 'browser_navigate':
      return doNavigate(run, args.url);
    case 'browser_new_tab':
      return doNewTab(run, args.url);
    case 'browser_switch_tab':
      return doSwitchTab(run, args.tabId);
    case 'browser_tabs':
      return doListTabs(run);
    case 'browser_snapshot':
      return doSnapshot(run);
    case 'browser_click':
      return doClick(run, args.ref);
    case 'browser_type':
      return doType(run, args.ref, args.text, args.submit);
    case 'browser_press_key':
      return doPressKey(run, args.key);
    case 'browser_send_keys':
      return doSendKeys(run, args);
    case 'browser_read_terminal':
      return doReadTerminal(run, args.maxChars);
    case 'browser_focus_terminal':
      return doFocusTerminal(run);
    case 'browser_scroll':
      return doScroll(run, args.direction, args.amount);
    case 'browser_extract':
      return doExtract(run, args.selector, args.attr, args.limit);
    case 'browser_extract_from_tab':
      return doExtractFromTab(run, args.tabId, args.selector, args.attr, args.limit, args.frameId);
    case 'browser_page_text':
      return doPageText(run, args.tabId, args.maxChars, args.frameId, args.offset);
    case 'browser_iframes':
      return doListIframes(run);
    case 'browser_focus_frame':
      return doFocusFrame(run, args.frameId);
    case 'browser_click_text':
      return doClickText(run, args.text, args.exact);
    case 'browser_wait': {
      // Was silently clamped to 5000, so a request for 10000 reported
      // "waited: 5000" with no explanation and the agent kept re-waiting.
      const requested = Math.max(0, Number(args.ms) || 0);
      const ms = Math.min(MAX_WAIT_MS, requested);
      await abortableSleep(ms, run.abort.signal);
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

// Typing a command one browser_press_key per step costs one LLM round trip per
// character. The last log did this 142 times. Refuse the third single-character
// press in a row (waits in between do not reset the streak).
function charByCharGuard(run, name, args) {
  if (name === 'browser_wait') return null;
  const isCharKey = name === 'browser_press_key' && typeof args?.key === 'string' && args.key.length === 1;
  run.charKeyStreak = isCharKey ? (run.charKeyStreak || 0) + 1 : 0;
  if (isCharKey && run.charKeyStreak >= 3) {
    return {
      ok: false,
      error:
        'Refused: this is the third single-character browser_press_key in a row. Nothing was pressed. ' +
        'Typing text one key per step is extremely slow. Send the whole string with browser_send_keys ' +
        '(it verifies the echo, presses Enter with submit:true and returns the command output).'
    };
  }
  return null;
}

function noFocusTab() {
  return {
    ok: false,
    error: 'No focus tab — the tab this agent was working in has been closed.',
    hint: 'Call browser_tabs, then browser_switch_tab to one of your tabs or browser_new_tab.'
  };
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

function abortableSleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener?.('abort', done);
      resolve();
    }
    signal?.addEventListener?.('abort', done, { once: true });
  });
}

async function attachDebugger(run, tabId) {
  if (!chrome.debugger) throw new Error('chrome.debugger API unavailable');
  if (!attachedTabs.has(tabId)) {
    await new Promise((resolve, reject) => {
      chrome.debugger.attach({ tabId }, '1.3', () => {
        const err = chrome.runtime.lastError;
        if (err && !/already attached/i.test(err.message)) reject(new Error(err.message));
        else resolve();
      });
    });
    attachedTabs.add(tabId);
  }
  run?.debugTabs?.add(tabId);
}

async function detachDebugger(tabId) {
  if (!attachedTabs.has(tabId)) return;
  attachedTabs.delete(tabId);
  await new Promise((resolve) => chrome.debugger.detach({ tabId }, () => { void chrome.runtime.lastError; resolve(); }));
}

// Detach only the tabs no other active run is still typing into.
async function detachRunDebuggers(run) {
  for (const id of Array.from(run.debugTabs || [])) {
    const stillUsed = Array.from(agentRuns.values()).some((r) => r !== run && !r.finished && r.debugTabs.has(id));
    if (!stillUsed) await detachDebugger(id);
  }
  run.debugTabs?.clear();
}

chrome.debugger?.onDetach?.addListener?.((source) => {
  if (source?.tabId != null) attachedTabs.delete(source.tabId);
});

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

// ---------------------------------------------------------------------------
// Echo verification and command output
// ---------------------------------------------------------------------------

// Normalised comparison: terminals hard-wrap long lines, so whitespace in the
// echo never matches what we sent.
const squash = (s) => String(s || '').replace(/\s+/g, '');
const PROMPT_RE = /[$#%>❯»]\s*$/;
// Sources where the typed text is at the cursor at the END of the sample.
// Code editors and rich-text fields can be edited mid-document, so for those
// "the text appears somewhere" is the best available check.
const TERMINAL_SOURCES = new Set(['xterm-dom', 'xterm-accessibility', 'termjs', 'ace-terminal', 'body']);
const INCLUDES_SOURCES = new Set(['contenteditable', 'ace-editor']);
const UNVERIFIED_NOTE =
  'Could not read this target back, so the typed text is UNVERIFIED — a canvas-rendered terminal (xterm.js with the canvas/WebGL renderer) keeps no text in the DOM. ' +
  'Confirm the effect some other way, e.g. redirect output to a file and read the file, before relying on it.';

// Remembers targets that ignore Input.insertText (term.js listens for key
// events on a DIV), so later sends skip straight to key events.
const inputModeCache = new Map();

async function readEcho(run, tabId) {
  try {
    const r = await sendToContent(run, tabId, { type: 'echoProbe' });
    return r?.ok ? r : null;
  } catch {
    return null;
  }
}

async function readTerminalText(run, tabId) {
  try {
    const r = await sendToContent(run, tabId, { type: 'terminalText' });
    return r?.ok && r.readable ? String(r.text || '') : null;
  } catch {
    return null;
  }
}

function lastNonEmptyLine(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : '';
}

function echoMatches(source, sample, expected) {
  const landed = squash(sample);
  return INCLUDES_SOURCES.has(source) ? landed.includes(expected) : landed.endsWith(expected);
}

// Poll the echo instead of reading it once after a fixed 120ms. Remote
// terminals (CloudShell, lab consoles) echo over a websocket and routinely take
// longer than that, so every command used to be judged "not landed", cleared
// with Ctrl+U and retyped three times at slower and slower speeds.
async function waitForEcho(run, tabId, expected, beforeSample, timeoutMs) {
  const start = Date.now();
  let last = null;
  for (;;) {
    const r = await readEcho(run, tabId);
    if (!r || r.readable === false) return { readable: false, source: r?.source };
    last = r;
    if (echoMatches(r.source, r.sample, expected)) return { readable: true, landed: true, sample: r.sample, source: r.source };
    if (Date.now() - start >= timeoutMs) break;
    await sleep(100);
  }
  return { readable: true, landed: false, changed: last.sample !== beforeSample, sample: last.sample, source: last.source };
}

async function clearCurrentInput(tabId, source) {
  if (source === 'field') {
    await realKey(tabId, { ...charSpec('a'), modifiers: MOD.ctrl, text: '' });
    await realKey(tabId, { ...NAMED_KEYS.Backspace, key: 'Backspace', modifiers: 0 });
  } else {
    await realKey(tabId, { ...charSpec('u'), modifiers: MOD.ctrl, text: '' });
  }
  await sleep(150);
}

async function typeBody(tabId, body, delayMs) {
  for (const ch of body) {
    await realKey(tabId, charSpec(ch));
    if (delayMs > 0) await sleep(delayMs);
  }
}

// Get `body` into the focused element and confirm it arrived. Never presses
// the final Enter — the caller does that only on success.
async function typeAndVerify(run, tabId, body, delayOpt) {
  const multiline = /[\r\n]/.test(body);
  const expected = squash(lastNonEmptyLine(body)).slice(-60);
  const cacheKey = `${tabId}:${run.focusFrame ?? 0}`;
  const before = await readEcho(run, tabId);
  const readable = !!before && before.readable !== false;
  let delayMs = Number.isFinite(delayOpt) ? Math.max(0, Math.min(200, delayOpt)) : 10;

  if (!readable) {
    // Nothing to verify against (canvas terminal). Key events are the most
    // reliable path there; type once, no retries.
    await typeBody(tabId, body, delayMs);
    return { ok: true, verified: null, mode: 'keys', source: before?.source, note: UNVERIFIED_NOTE };
  }

  // 1) Paste the whole string with one CDP call. This is ~100x faster than a
  // keyDown/keyUp pair per character, and multi-line text (heredocs, python -c)
  // arrives in one piece instead of executing line by line mid-typing.
  if (inputModeCache.get(cacheKey) !== 'keys') {
    let pasted = true;
    try { await cdp(tabId, 'Input.insertText', { text: body }); } catch { pasted = false; }
    if (pasted) {
      const echo = await waitForEcho(run, tabId, expected, before.sample, 2000);
      if (echo.landed) return { ok: true, verified: true, mode: 'paste', source: echo.source };
      if (echo.readable === false) return { ok: true, verified: null, mode: 'paste', source: echo.source, note: UNVERIFIED_NOTE };
      if (echo.changed) {
        if (multiline || INCLUDES_SOURCES.has(echo.source)) {
          return {
            ok: false,
            verified: false,
            mode: 'paste',
            error:
              'The pasted text did not echo as expected. Enter was NOT pressed. It was not retried: multi-line input may already have been ' +
              'partly consumed, and retyping would duplicate it.',
            landed: String(echo.sample || '').slice(-300),
            hint: 'Read the result with browser_read_terminal. On a shell, press Ctrl+C with browser_press_key to get a clean prompt before trying again.'
          };
        }
        await clearCurrentInput(tabId, echo.source);
      } else {
        inputModeCache.set(cacheKey, 'keys');
      }
    }
  }

  // 2) Real key events.
  if (multiline) {
    // No retries: every newline has already run a line, so clearing and
    // retyping would duplicate input — which is exactly how the last run ended
    // up with four copies of a heredoc in the shell.
    const pre = (await readEcho(run, tabId)) || before;
    await typeBody(tabId, body, delayMs);
    const echo = await waitForEcho(run, tabId, expected, pre.sample, 2000);
    if (echo.readable === false) return { ok: true, verified: null, mode: 'keys', source: echo.source, note: UNVERIFIED_NOTE };
    if (echo.landed) return { ok: true, verified: true, mode: 'keys', source: echo.source };
    return {
      ok: false,
      verified: false,
      mode: 'keys',
      error: 'Multi-line text was typed but its last line did not echo. Enter was NOT pressed; earlier lines may already have run.',
      landed: String(echo.sample || '').slice(-300),
      hint: 'Read the terminal with browser_read_terminal, then press Ctrl+C with browser_press_key to reset the prompt.'
    };
  }

  const attempts = [];
  let lastEcho = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const pre = (await readEcho(run, tabId)) || before;
    await typeBody(tabId, body, delayMs);
    const echo = await waitForEcho(run, tabId, expected, pre.sample, 1500);
    lastEcho = echo;
    attempts.push({ attempt, delayMs, verified: !!echo.landed });
    if (echo.readable === false) return { ok: true, verified: null, mode: 'keys', attempts: attempt, source: echo.source, note: UNVERIFIED_NOTE };
    if (echo.landed) return { ok: true, verified: true, mode: 'keys', attempts: attempt, source: echo.source };
    // Nothing reached the target at all: that is a focus problem, and retyping
    // more slowly cannot fix it.
    if (!echo.changed || INCLUDES_SOURCES.has(echo.source)) break;
    await clearCurrentInput(tabId, echo.source);
    delayMs = Math.min(200, Math.max(40, delayMs * 4));
  }

  return {
    ok: false,
    verified: false,
    submitted: false,
    mode: 'keys',
    attempts,
    error: lastEcho?.changed
      ? 'The characters that reached the target did not match what was sent. The line was cleared and Enter was NOT pressed.'
      : 'Nothing changed in the target after pasting and typing — the keystrokes are not reaching it. Enter was NOT pressed.',
    sent: body.slice(0, 200),
    landed: String(lastEcho?.sample || '').slice(-200),
    hint: lastEcho?.changed
      ? 'Retry once with a higher delayMs. If it still fails, read the terminal to see what is being mangled.'
      : 'Call browser_focus_terminal (or click inside the terminal) and retry once. If it still fails, stop retrying variants: use another terminal the task allows, or call browser_ask_user.'
  };
}

// After Enter: wait until the shell prompt is back (or the output goes quiet),
// then return what the command printed. This turns "send_keys, then page_text
// to see the result" — two LLM round trips per command — into one.
async function captureCommandOutput(run, tabId, beforeText, waitMs) {
  const start = Date.now();
  let lastText = beforeText;
  let lastChange = start;
  let finished = false;
  while (Date.now() - start < waitMs && !run.abort.signal.aborted) {
    await sleep(250);
    const t = await readTerminalText(run, tabId);
    if (t == null) return null;
    const now = Date.now();
    if (t !== lastText) {
      lastText = t;
      lastChange = now;
    }
    if (t !== beforeText && PROMPT_RE.test(lastNonEmptyLine(t)) && now - lastChange >= 300) {
      finished = true;
      break;
    }
  }
  return { finished, text: lastText, waitedMs: Date.now() - start };
}

function extractOutput(text, commandLastLine, finished) {
  const lines = String(text || '').split('\n').map((l) => l.replace(/\s+$/, ''));
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const needle = squash(commandLastLine).slice(-40);
  let idx = -1;
  if (needle) {
    // The echoed command may be hard-wrapped across several rows, so match the
    // needle against the tail of up to six joined rows ending at row i.
    for (let i = lines.length - 1; i >= 0 && idx < 0; i--) {
      let acc = '';
      for (let m = 0; m < 6 && i - m >= 0; m++) {
        acc = squash(lines[i - m]) + acc;
        if (acc.length >= needle.length) {
          if (acc.endsWith(needle)) idx = i;
          break;
        }
      }
    }
  }
  let out = idx >= 0 ? lines.slice(idx + 1) : lines.slice(-40);
  if (finished && out.length && PROMPT_RE.test(out[out.length - 1].trim())) out = out.slice(0, -1);
  let output = out.join('\n');
  const truncated = output.length > 4000;
  if (truncated) output = '…' + output.slice(-4000);
  return { output, truncated, located: idx >= 0 };
}

async function doSendKeys(run, args) {
  // The model sometimes calls send_keys({ key: "Ctrl+C" }). That used to type
  // an empty string and report verified:true, so the Ctrl+C never happened and
  // a heredoc stayed open for a dozen steps.
  if ((args.text == null || args.text === '') && typeof args.key === 'string' && args.key) {
    const r = await doPressKey(run, args.key);
    return { ...r, note: 'browser_send_keys received "key" instead of "text", so the key was pressed via browser_press_key. Use browser_press_key for keys and chords.' };
  }
  const body = String(args.text ?? '');
  const submit = !!args.submit;
  if (!body && !submit) {
    return { ok: false, error: 'browser_send_keys needs a non-empty "text" (or submit:true to just press Enter). Nothing was sent. For keys like Ctrl+C use browser_press_key.' };
  }
  const tab = await getFocusTab(run);
  if (!tab) return noFocusTab();
  const enter = { ...NAMED_KEYS.Enter, key: 'Enter', modifiers: 0 };
  const waitMs = Number.isFinite(args.waitMs) ? Math.max(0, Math.min(MAX_WAIT_MS, args.waitMs)) : DEFAULT_COMMAND_WAIT_MS;

  try {
    await attachDebugger(run, tab.id);
  } catch (e) {
    try {
      const r = await sendToContent(run, tab.id, { type: 'sendKeys', text: body, submit });
      return {
        ...r,
        mode: 'synthetic',
        warning: `Real input unavailable (${e.message || e}); fell back to synthetic key events, which terminals and canvas editors usually ignore. Verify before trusting this.`
      };
    } catch (e2) {
      return { ok: false, error: `Real input failed (${e.message || e}); synthetic fallback also failed (${e2.message || e2})` };
    }
  }

  let typed = { ok: true, verified: true, mode: 'none', source: null };
  if (body) {
    typed = await typeAndVerify(run, tab.id, body, args.delayMs);
  } else {
    typed.source = (await readEcho(run, tab.id))?.source ?? null;
  }

  if (!typed.ok) {
    run.terminalFailures = (run.terminalFailures || 0) + 1;
    return withStrategyHint(run, { ...typed, submitted: false, tabId: tab.id });
  }
  if (typed.verified === true) run.terminalFailures = 0;

  const result = {
    ok: true,
    typed: body.length,
    submitted: false,
    mode: typed.mode,
    verified: typed.verified,
    tabId: tab.id,
    ...(typed.attempts ? { attempts: typed.attempts } : {}),
    ...(typed.note ? { note: typed.note } : {})
  };
  if (!submit) return result;

  const terminalLike = TERMINAL_SOURCES.has(typed.source);
  let beforeText = terminalLike && waitMs > 0 ? await readTerminalText(run, tab.id) : null;
  // A plain page body only counts as a terminal if a shell prompt precedes
  // what we just typed.
  if (beforeText != null && typed.source === 'body' && !/[$#%>❯»]\s/.test(lastNonEmptyLine(beforeText))) beforeText = null;

  await realKey(tab.id, enter);
  result.submitted = true;

  if (beforeText != null) {
    const cap = await captureCommandOutput(run, tab.id, beforeText, waitMs);
    if (cap) {
      const out = extractOutput(cap.text, lastNonEmptyLine(body), cap.finished);
      result.output = out.output;
      if (out.truncated) result.outputTruncated = true;
      result.finished = cap.finished;
      result.waitedMs = cap.waitedMs;
      if (!cap.finished) {
        result.note2 =
          `No shell prompt came back within ${waitMs}ms — the command may still be running or be waiting for input. ` +
          'Call browser_read_terminal later (or pass a larger waitMs next time) instead of re-running it.';
      }
    }
  }
  return result;
}

function withStrategyHint(run, obs) {
  if ((run.terminalFailures || 0) >= 3) {
    obs.strategyHint =
      `Input to this target has now failed ${run.terminalFailures} times in a row. Stop trying variations ` +
      '(press_key per character, different delays, re-clicking). Switch to another terminal or tool the task allows, or call browser_ask_user.';
  }
  return obs;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

// The run's focus tab, else its owner tab. Never the user's active tab: with
// several agents running, falling back to "whatever the user is looking at"
// would let an agent type into an unrelated page.
async function getFocusTab(run) {
  for (const id of [run.focusTabId, run.ownerTabId]) {
    if (id == null) continue;
    try {
      const t = await chrome.tabs.get(id);
      if (t) {
        if (id !== run.focusTabId) {
          run.focusTabId = id;
          run.focusFrame = 0;
        }
        return t;
      }
    } catch {}
  }
  return null;
}

// Whether the user is currently looking at one of this run's tabs. Tab
// switches and new tabs only take over the window in that case, so an agent
// working in the background does not yank the user away from another page.
async function userIsWatching(run, tabId) {
  try {
    const t = await chrome.tabs.get(tabId);
    const [active] = await chrome.tabs.query({ active: true, windowId: t.windowId });
    return !!active && run.ownedTabs.has(active.id);
  } catch {
    return false;
  }
}

async function sendToContent(run, tabId, payload, opts = {}) {
  // Target the run's focus frame unless the caller pins one.
  //
  // This used to silently retry on frame 0 when the target frame did not
  // answer. That turned "your frame switch failed" into "here is the top
  // document again", so the agent could focus a frame that never existed,
  // keep reading frame 0, see identical snapshots, and loop until it ran out
  // of steps. A failed frame send is now a hard, explicit error.
  const frameId = (opts && typeof opts.frameId === 'number') ? opts.frameId : (run?.focusFrame ?? 0);
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

async function ensureContentScript(run, tabId) {
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
        target: { tabId, frameIds: [run?.focusFrame ?? 0] },
        files: ['content/extractor.js']
      });
    } catch {
      throw e;
    }
  }
}

// Send to the focus frame; inject the content script and retry once if the
// frame did not answer.
async function sendWithInject(run, tabId, payload) {
  try {
    return await sendToContent(run, tabId, payload);
  } catch {
    try {
      await ensureContentScript(run, tabId);
      return await sendToContent(run, tabId, payload);
    } catch (e2) {
      return { ok: false, error: String(e2.message || e2) };
    }
  }
}

async function doNavigate(run, url) {
  const tab = await getFocusTab(run);
  if (!tab) return noFocusTab();
  const watching = await userIsWatching(run, tab.id);
  await chrome.tabs.update(tab.id, watching ? { url, active: true } : { url });
  run.focusFrame = 0; // navigation changes frame tree
  await recordFocus(run, tab.id, 0);
  await waitForTabComplete(tab.id, 15000).catch(() => {});
  return { ok: true, url, tabId: tab.id };
}

async function doNewTab(run, url) {
  let anchor = null;
  try { anchor = await chrome.tabs.get(run.focusTabId ?? run.ownerTabId); } catch {}
  const watching = anchor ? await userIsWatching(run, anchor.id) : false;
  const tab = await chrome.tabs.create({
    url,
    active: watching,
    ...(anchor ? { windowId: anchor.windowId, index: anchor.index + 1 } : {})
  });
  run.ownedTabs.add(tab.id);
  run.focusFrame = 0;
  await recordFocus(run, tab.id, 0);
  await waitForTabComplete(tab.id, 15000).catch(() => {});
  return {
    ok: true,
    tabId: tab.id,
    url,
    ...(watching ? {} : { openedInBackground: true, note: 'Opened without activating it, because the user is looking at a tab this agent does not own. Actions still target it.' })
  };
}

async function doSwitchTab(run, tabId) {
  if (typeof tabId !== 'number') return { ok: false, error: 'tabId must be a number from browser_tabs.' };
  const other = tabOwnerConflict(tabId, run);
  if (other) {
    return {
      ok: false,
      error:
        `Tab ${tabId} is being driven by another agent run (started from tab ${other.ownerTabId}). Focus unchanged. ` +
        'Use a different tab, or read it without switching via browser_extract_from_tab / browser_page_text with tabId.'
    };
  }
  try {
    await chrome.tabs.get(tabId);
  } catch {
    return { ok: false, error: `No tab with id ${tabId}.`, hint: 'Call browser_tabs for the live tab ids.' };
  }
  const watching = await userIsWatching(run, tabId);
  if (watching) await chrome.tabs.update(tabId, { active: true });
  run.focusFrame = 0; // reset until we know the new frame tree
  await recordFocus(run, tabId, 0);
  return { ok: true, tabId, activated: watching };
}

async function doListTabs(run) {
  let windowId = null;
  try { windowId = (await chrome.tabs.get(run.ownerTabId)).windowId; } catch {}
  const tabs = await chrome.tabs.query(windowId != null ? { windowId } : { lastFocusedWindow: true });
  return {
    ok: true,
    focusTabId: run.focusTabId ?? null,
    tabs: tabs.map((t) => {
      const other = tabOwnerConflict(t.id, run);
      return {
        id: t.id,
        title: truncate(t.title, 100),
        url: truncate(t.url, 150),
        active: t.active,
        ...(run.ownedTabs.has(t.id) ? { yours: true } : {}),
        ...(other ? { busyByOtherAgent: true } : {})
      };
    })
  };
}

// The snapshot used to be a JSON array with selector/x/y/attrs per element —
// about 2.4KB for 25 elements, re-sent on every later step. One line per
// element carries what the model actually uses at a fraction of the size.
function compactSnapshot(r) {
  if (!r || !r.ok || !Array.isArray(r.elements)) return r;
  const out = {
    ok: true,
    url: truncate(r.url, 200),
    title: r.title,
    isTop: r.isTop,
    frameId: r.frameId,
    elementCount: r.elements.length,
    elements: r.elements.map(describeElementLine).join('\n')
  };
  if (Array.isArray(r.iframes) && r.iframes.length) {
    out.iframes = r.iframes.map((f) =>
      [
        'iframe',
        f.id ? `#${f.id}` : '',
        f.name ? `name=${f.name}` : '',
        truncate(f.liveSrc || f.srcAttr || '', 100),
        f.visible ? '' : '(hidden)'
      ].filter(Boolean).join(' ')
    );
    out.iframeHint = 'Content inside iframes is not listed. Call browser_iframes, then browser_focus_frame.';
  }
  return out;
}

function describeElementLine(e) {
  const a = e.attrs || {};
  let s = `[${e.ref}] ${e.tag}`;
  if (a.id) s += `#${a.id}`;
  if (a.type) s += ` type=${a.type}`;
  if (a.role && a.role !== e.tag) s += ` role=${a.role}`;
  if (a.name) s += ` name=${a.name}`;
  const text = String(e.text || '').replace(/\s+/g, ' ').trim();
  // labelOf() falls back to el.value; never echo a password field's value.
  if (text && a.type !== 'password') s += ` "${truncate(text, 80)}"`;
  if (a['aria-label'] && a['aria-label'] !== text) s += ` aria="${truncate(a['aria-label'], 60)}"`;
  if (a.placeholder) s += ` placeholder="${truncate(a.placeholder, 60)}"`;
  if (a.href && !/^javascript:/i.test(a.href)) s += ` href=${truncate(a.href, 80)}`;
  if (e.isFrame) s += ` (iframe${a.src ? ' src=' + truncate(a.src, 80) : ''} — use browser_iframes)`;
  return s;
}

async function doSnapshot(run) {
  const tab = await getFocusTab(run);
  if (!tab) return noFocusTab();
  try {
    const r = await sendToContent(run, tab.id, { type: 'snapshot' });
    return compactSnapshot(r) || { ok: false, error: 'No response' };
  } catch (e) {
    try {
      await ensureContentScript(run, tab.id);
      const r = await sendToContent(run, tab.id, { type: 'snapshot' });
      return compactSnapshot(r) || { ok: false, error: 'No response after inject' };
    } catch (e2) {
      return { ok: false, error: `Cannot access frame ${run.focusFrame ?? 0}: ${e2.message || e2}` };
    }
  }
}

async function doClick(run, ref) {
  const tab = await getFocusTab(run);
  if (!tab) return noFocusTab();
  return sendWithInject(run, tab.id, { type: 'click', ref });
}

async function doType(run, ref, text, submit) {
  const tab = await getFocusTab(run);
  if (!tab) return noFocusTab();
  return sendWithInject(run, tab.id, { type: 'type', ref, text, submit: !!submit });
}

async function doPressKey(run, key) {
  const tab = await getFocusTab(run);
  if (!tab) return noFocusTab();

  // Previously ANY string was accepted: "ctrl+grave", "Ctrl+C" and "F5" all
  // returned ok:true while dispatching a key code of 0, i.e. nothing at all.
  const spec = parseKeySpec(key);
  if (!spec) {
    const looksLikeText = typeof key === 'string' && key.length > 1 && !key.includes('+');
    return {
      ok: false,
      error: `Unrecognised key "${key}". Nothing was pressed.`,
      validKeys: Object.keys(NAMED_KEYS),
      format: 'A single character ("a", "/"), a named key ("Enter", "F5", "ArrowDown"), or modifiers joined with + ("Ctrl+C", "Ctrl+Shift+P").',
      ...(looksLikeText ? { hint: 'To type text, use browser_send_keys with the whole string.' } : {})
    };
  }

  try {
    await attachDebugger(run, tab.id);
    await realKey(tab.id, spec);
    return { ok: true, key, resolved: { key: spec.key, code: spec.code, modifiers: spec.modifiers }, mode: 'real', tabId: tab.id };
  } catch {}
  try {
    return await sendToContent(run, tab.id, { type: 'pressKey', key: spec.key, ctrl: !!(spec.modifiers & 2), shift: !!(spec.modifiers & 8), alt: !!(spec.modifiers & 1), meta: !!(spec.modifiers & 4) });
  } catch (e) {
    try {
      await ensureContentScript(run, tab.id);
      return await sendToContent(run, tab.id, { type: 'pressKey', key: spec.key });
    } catch (e2) {
      return { ok: false, error: String(e2.message || e2) };
    }
  }
}

async function doReadTerminal(run, maxChars) {
  const tab = await getFocusTab(run);
  if (!tab) return noFocusTab();
  try {
    const r = await sendToContent(run, tab.id, { type: 'readTerminal' });
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

async function doFocusTerminal(run) {
  // term.js / tty.js accept keystrokes on a hidden textarea or a focusable DIV;
  // without focus on that exact element, CDP key events vanish. Call this AFTER
  // clicking "Launch Terminal" and waiting for the prompt, BEFORE browser_send_keys.
  const tab = await getFocusTab(run);
  if (!tab) return noFocusTab();
  const r = await sendWithInject(run, tab.id, { type: 'focusTerminal' });
  return r || { ok: false, error: 'No response' };
}

async function doScroll(run, direction, amount) {
  const tab = await getFocusTab(run);
  if (!tab) return noFocusTab();
  return sendWithInject(run, tab.id, { type: 'scroll', direction, amount });
}

async function doExtract(run, selector, attr, limit) {
  const tab = await getFocusTab(run);
  if (!tab) return noFocusTab();
  return sendWithInject(run, tab.id, { type: 'extract', selector, attr, limit });
}

async function doExtractFromTab(run, tabId, selector, attr, limit, frameId) {
  if (tabId == null) return { ok: false, error: 'tabId required' };
  // Used to hard-code frame 0, so reading a tab whose content lives in an
  // iframe returned the outer shell (often just "enable JavaScript").
  try {
    return await sendToContent(run, tabId, { type: 'extract', selector, attr, limit }, { frameId: frameId ?? 0 });
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

async function doPageText(run, tabId, maxChars, frameId, offset) {
  const targetId = tabId ?? (await getFocusTab(run))?.id;
  if (targetId == null) return { ok: false, error: 'No tab to read' };
  // Another tab's focus frame means nothing here; read its top document.
  const usedFrame = frameId ?? (tabId == null || tabId === run.focusTabId ? run.focusFrame ?? 0 : 0);
  try {
    const r = await sendToContent(run, targetId, { type: 'extractContent' }, { frameId: usedFrame });
    if (!r || !r.ok) return r || { ok: false, error: 'No response' };
    const max = Math.max(500, Math.min(30000, maxChars || 6000));
    const full = r.content || '';
    const start = Math.max(0, Math.min(full.length, Number(offset) || 0));
    const text = full.slice(start, start + max);
    return {
      ok: true,
      tabId: targetId,
      frameId: usedFrame,
      url: truncate(r.url, 150),
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
async function describeFrames(run, tabId) {
  let webFrames = [];
  try {
    webFrames = (await chrome.webNavigation.getAllFrames({ tabId })) || [];
  } catch {}
  if (!webFrames.length) webFrames = [{ frameId: 0, parentFrameId: -1, url: '' }];

  try {
    await ensureContentScript(run, tabId);
  } catch {}

  const probes = await Promise.all(
    webFrames.map((wf) => chrome.tabs.sendMessage(tabId, { type: 'probe' }, { frameId: wf.frameId }).catch(() => null))
  );
  return webFrames.map((wf, i) => {
    const probe = probes[i];
    return {
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
    };
  });
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

async function doListIframes(run) {
  const tab = await getFocusTab(run);
  if (!tab) return noFocusTab();

  const frames = await describeFrames(run, tab.id);

  // DOM-level <iframe> tags from the CURRENT focus frame, for extra context
  // (title/name/size) — useful but never the source of frameId.
  let domIframes = [];
  try {
    const r = await sendToContent(run, tab.id, { type: 'listIframes' });
    if (r?.ok) domIframes = r.iframes || [];
  } catch {}

  const reachable = frames.filter((f) => f.reachable && f.frameId !== 0);
  const suggestion = reachable
    .slice()
    .sort((a, b) => (b.interactiveCount || 0) - (a.interactiveCount || 0))[0];

  return {
    ok: true,
    focusTabId: tab.id,
    focusFrame: run.focusFrame ?? 0,
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

async function doFocusFrame(run, frameId) {
  if (typeof frameId !== 'number' || !Number.isInteger(frameId) || frameId < 0) {
    return { ok: false, error: 'frameId must be a non-negative integer (0 = top document)' };
  }
  const tab = await getFocusTab(run);
  if (!tab) return noFocusTab();

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
        `Frame ${frameId} does not exist in tab ${tab.id}. Focus unchanged (still frame ${run.focusFrame ?? 0}). ` +
        'Chrome frame ids are arbitrary numbers, not 0,1,2 — do not guess them. Call browser_iframes first.',
      validFrameIds: webFrames.map((f) => f.frameId),
      focusFrame: run.focusFrame ?? 0
    };
  }

  // Confirm the frame can actually be scripted before committing the switch.
  let probe = null;
  try {
    probe = await chrome.tabs.sendMessage(tab.id, { type: 'probe' }, { frameId });
  } catch {
    try {
      await ensureContentScript(run, tab.id);
      probe = await chrome.tabs.sendMessage(tab.id, { type: 'probe' }, { frameId });
    } catch {}
  }

  if (!probe?.ok) {
    return {
      ok: false,
      error:
        `Frame ${frameId} exists but cannot be scripted (sandboxed, restricted, or still loading). ` +
        `Focus unchanged (still frame ${run.focusFrame ?? 0}). ` +
        'Try browser_wait then retry, pick another frame from browser_iframes, or open its url with browser_new_tab.',
      focusFrame: run.focusFrame ?? 0
    };
  }

  run.focusFrame = frameId;
  emit(run, {
    type: 'agent:focus',
    tabId: tab.id,
    frameId,
    url: probe.url || tab.url,
    title: probe.title || tab.title,
    history: run.focusHistory || []
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

async function doClickText(run, text, exact) {
  const tab = await getFocusTab(run);
  if (!tab) return noFocusTab();
  return sendWithInject(run, tab.id, { type: 'clickByText', text, exact: !!exact });
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
