// sidepanel/sidepanel.js
// Wires up the chat and agent views. Communicates with the background SW via
// a long-lived port (chrome.runtime.connect) so we can render streamed tokens
// and live agent events.
//
// Runs are per tab. The panel shows the chat thread of the tab the user is
// looking at, and the agent run started from (or driving) that tab. Events
// from runs in other tabs are ignored here; switching to such a tab loads and
// replays that run's log from the background, so an agent busy in one tab
// never blocks chatting or starting another task in a different tab.

const els = {
  pageContext: document.getElementById('page-context'),
  messages: document.getElementById('messages'),
  input: document.getElementById('input'),
  send: document.getElementById('send'),
  clear: document.getElementById('btn-clear'),
  settings: document.getElementById('btn-settings'),
  quickRow: document.getElementById('quick-row'),
  includePage: document.getElementById('include-page'),
  agentLog: document.getElementById('agent-log'),
  agentStatus: document.getElementById('agent-status'),
  focusBadge: document.getElementById('focus-badge'),
  focusTitle: document.querySelector('#focus-badge .focus-title'),
  focusBreadcrumb: document.getElementById('focus-breadcrumb'),
  otherRuns: document.getElementById('other-runs'),
  abort: document.getElementById('btn-abort'),
  askUserRow: document.getElementById('ask-user-row'),
  askQ: document.getElementById('ask-q'),
  askInput: document.getElementById('ask-input'),
  askSend: document.getElementById('ask-send'),
  viewChat: document.getElementById('view-chat'),
  viewAgent: document.getElementById('view-agent')
};

let currentTab = 'chat';
let currentAssistantMsg = null; // { node, content }
let currentTabId = null;        // the browser tab whose chat is shown right now
let currentAgentOwner = null;   // owner tab of the agent run shown in the Agent view
let shownRunActive = false;     // whether that agent run is still running
let myWindowId = null;          // ignore tab switches in other windows
let activeRuns = [];            // [{ ownerTabId, title, awaitingUser }]
let loadSeq = 0;

chrome.windows?.getCurrent?.()
  .then((w) => { myWindowId = w?.id ?? null; })
  .catch(() => {});

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    currentTab = btn.dataset.tab;
    els.viewChat.classList.toggle('active', currentTab === 'chat');
    els.viewAgent.classList.toggle('active', currentTab === 'agent');
    updateInputPlaceholder();
  });
});

function updateInputPlaceholder() {
  els.input.placeholder =
    currentTab === 'chat' ? 'Ask about this page…' : 'Tell the agent what to do…';
}

// ---------------------------------------------------------------------------
// Connection to background
// ---------------------------------------------------------------------------

const port = chrome.runtime.connect({ name: 'bu-stream' });
port.postMessage({ type: 'hello' });

port.onMessage.addListener((evt) => {
  switch (evt.type) {
    case 'hello-ack':
    case 'runs:changed':
      activeRuns = evt.runs || [];
      renderOtherRuns();
      return;
    case 'tab:activated':
      // User switched tabs in the main browser window — reload the chat
      // thread and agent run for the newly active tab.
      if (myWindowId != null && evt.windowId != null && evt.windowId !== myWindowId) return;
      onTabActivated(evt.tabId);
      return;
    case 'tab:closed':
      // If the user closed the tab we're showing, blank the chat.
      if (evt.tabId === currentTabId) {
        currentTabId = null;
        renderThreadMessages([]);
        currentAssistantMsg = null;
      }
      return;
    case 'chat:updated':
      // Background pushed the new thread for the tab we care about (covers
      // local edits, regenerate, clear, and SW-restart rehydration).
      if (evt.tabId === currentTabId) {
        // If we are mid-stream, don't blow away the in-flight assistant
        // message — the background will push chat:updated again after the
        // assistant reply is appended.
        if (currentAssistantMsg && currentAssistantMsg.role === 'assistant' && !evt.messages.length) {
          renderThreadMessages([]);
        } else if (!currentAssistantMsg) {
          renderThreadMessages(evt.messages);
        }
      }
      return;
  }

  // An agent from another tab just moved onto the tab we are showing.
  if (
    evt.type === 'agent:focus' &&
    evt.tabId === currentTabId &&
    evt.ownerTabId !== currentAgentOwner &&
    !shownRunActive
  ) {
    loadTab(currentTabId);
    return;
  }

  // Run events belong to the tab that started the run; errors about a request
  // this panel made (no ownerTabId) are always shown.
  if (evt.ownerTabId != null) {
    const shown = evt.runKind === 'agent' ? currentAgentOwner : currentTabId;
    if (evt.ownerTabId !== shown) return;
  }
  handleRunEvent(evt, false);
});

function handleRunEvent(evt, replay) {
  switch (evt.type) {
    case 'run:start':
      onRunStart(evt);
      break;
    case 'agent:task':
      appendAgentEntry('final', `▶ Task: ${evt.task}`);
      break;
    case 'token':
      onToken(evt);
      break;
    case 'reasoning':
      // Skip showing reasoning tokens (they waste space). Could be enabled later.
      break;
    case 'agent:step':
      setAgentStatus('running', `Step ${evt.step}`);
      break;
    case 'agent:toolCall':
      onAgentToolCall(evt.name, evt.args);
      break;
    case 'agent:toolResult':
      onAgentToolResult(evt.name, evt.observation);
      break;
    case 'agent:focus':
      onAgentFocus(evt);
      break;
    case 'agent:awaitingUser':
      showAskUser(evt.question, !replay);
      break;
    case 'agent:userReplied':
      appendAskHistory(evt.text);
      hideAskUser();
      break;
    case 'error':
      onError(evt);
      break;
    case 'run:end':
      onRunEnd(evt);
      break;
  }
}

// chrome.tabs.onActivated doesn't fire reliably while the side panel is the
// focused surface, so we also re-sync on window focus as a fallback for the
// common case of "side panel open, click another tab".
chrome.tabs.onActivated.addListener?.((info) => {
  if (myWindowId != null && info.windowId !== myWindowId) return;
  onTabActivated(info.tabId);
});

// ---------------------------------------------------------------------------
// Page context
// ---------------------------------------------------------------------------

async function refreshPageContext() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) {
      els.pageContext.textContent = 'No page';
      return;
    }
    els.pageContext.textContent = tab.title ? `${tab.title}` : (tab.url || 'No page');
    // Also pick up any pending selection from context menu
    chrome.storage.session?.get?.(['pendingSelection'], (r) => {
      if (r?.pendingSelection) {
        els.input.value = r.pendingSelection.text;
        chrome.storage.session?.remove?.(['pendingSelection']);
      }
    });
  } catch {
    els.pageContext.textContent = 'No page';
  }
}

async function getPageContext() {
  if (!els.includePage.checked) return null;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return null;
  try {
    const resp = await chrome.tabs.sendMessage(tab.id, { type: 'extractContent' });
    if (!resp || !resp.ok) return null;
    return {
      url: resp.url,
      title: resp.title,
      content: (resp.content || '').slice(0, 80000)
    };
  } catch {
    return null;
  }
}

els.input.addEventListener('focus', refreshPageContext);
refreshPageContext();

// ---------------------------------------------------------------------------
// Send / clear / settings
// ---------------------------------------------------------------------------

els.send.addEventListener('click', sendMessage);
els.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

els.clear.addEventListener('click', () => {
  // Clear only the current tab's chat thread. A finished agent log for this
  // tab is cleared too; a running agent is left alone (use Stop).
  if (currentTabId != null) {
    port.postMessage({ type: 'chat:clear', tabId: currentTabId });
  }
  els.messages.innerHTML = '';
  currentAssistantMsg = null;
  if (!shownRunActive) {
    if (currentAgentOwner != null) port.postMessage({ type: 'agent:clear', ownerTabId: currentAgentOwner });
    resetAgentView();
    currentAgentOwner = currentTabId;
    renderOtherRuns();
  }
});

els.settings.addEventListener('click', () => {
  chrome.runtime.openOptionsPage?.();
});

els.quickRow.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  els.input.value = chip.dataset.q;
  sendMessage();
});

els.abort.addEventListener('click', () => {
  if (currentAgentOwner != null) port.postMessage({ type: 'abort', ownerTabId: currentAgentOwner });
});

els.focusBadge.addEventListener('click', () => {
  const id = parseInt(els.focusBadge.dataset.tabId || '', 10);
  if (!isNaN(id)) chrome.tabs.update(id, { active: true });
});
els.focusBadge.style.cursor = 'pointer';
els.focusBadge.title = 'Click to follow the agent\'s tab';

els.askSend.addEventListener('click', sendAskReply);
els.askInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    sendAskReply();
  }
});

function sendAskReply() {
  const text = els.askInput.value.trim();
  if (!text || currentAgentOwner == null) return;
  // The background echoes an agent:userReplied event, which renders the reply.
  port.postMessage({ type: 'agent:userReply', ownerTabId: currentAgentOwner, text });
  els.askInput.value = '';
  hideAskUser();
}

function appendAskHistory(text) {
  const e = document.createElement('div');
  e.className = 'log-entry observation';
  e.innerHTML = `<div class="head">Your reply</div><div class="body"></div>`;
  e.querySelector('.body').textContent = text;
  els.agentLog.appendChild(e);
  els.agentLog.scrollTop = els.agentLog.scrollHeight;
}

async function sendMessage() {
  const text = els.input.value.trim();
  if (!text) return;

  // Snapshot the active tab id at the moment of send so the message belongs
  // to the tab the user is looking at, even if they switch mid-stream.
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabId = activeTab?.id ?? currentTabId;
  if (tabId == null) return;
  if (tabId !== currentTabId) {
    currentTabId = tabId;
    await loadTab(tabId);
  }

  if (currentTab === 'agent' && shownRunActive) {
    appendAgentEntry(
      'error',
      currentAgentOwner === tabId
        ? '⚠ An agent is already running in this tab. Press Stop first, or start the new task from another tab.'
        : `⚠ This tab is being driven by the agent started from tab ${currentAgentOwner}. Start the new task from another tab.`
    );
    return;
  }

  els.input.value = '';
  els.send.disabled = true;

  if (currentTab === 'chat') {
    appendMsg('user', text);
    const page = await getPageContext();
    port.postMessage({ type: 'chat:send', userText: text, page, tabId });
  } else {
    // A new run replaces the finished one shown for this tab. The background
    // sends run:start and the task entry.
    resetAgentView();
    currentAgentOwner = tabId;
    renderOtherRuns();
    const page = await getPageContext();
    port.postMessage({ type: 'agent:start', task: text, page, tabId });
  }

  setTimeout(() => { els.send.disabled = false; }, 50);
}

// ---------------------------------------------------------------------------
// Chat rendering
// ---------------------------------------------------------------------------

function appendMsg(role, text) {
  const m = document.createElement('div');
  m.className = `msg ${role}`;
  if (role !== 'system' && role !== 'error') {
    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = role === 'user' ? 'You' : 'Browser Use';
    m.appendChild(label);
  }
  const body = document.createElement('div');
  body.className = 'body';
  body.textContent = text || '';
  m.appendChild(body);
  els.messages.appendChild(m);
  els.messages.scrollTop = els.messages.scrollHeight;
  return body;
}

function ensureAssistantMsg() {
  if (currentAssistantMsg && currentAssistantMsg.role === 'assistant') {
    return currentAssistantMsg.node;
  }
  const node = appendMsg('assistant', '');
  currentAssistantMsg = { role: 'assistant', node, content: '' };
  return node;
}

function onRunStart(evt) {
  if (evt.kind === 'agent') {
    shownRunActive = true;
    els.abort.hidden = false;
    setAgentStatus('running', evt.resume ? 'Resuming…' : 'Starting…');
    hideAskUser();
  } else {
    currentAssistantMsg = null;
  }
}

function onToken(evt) {
  if (evt.runKind === 'agent') {
    const last = els.agentLog.lastElementChild;
    if (last && last.classList.contains('streaming')) {
      last.querySelector('.body').textContent += evt.content;
    } else {
      const e = appendAgentEntry('observation', 'Reasoning', evt.content);
      e.classList.add('streaming');
    }
    els.agentLog.scrollTop = els.agentLog.scrollHeight;
    return;
  }
  const node = ensureAssistantMsg();
  node.textContent += evt.content;
  currentAssistantMsg.content = node.textContent;
  els.messages.scrollTop = els.messages.scrollHeight;
}

function onError(evt) {
  const inAgent = evt.runKind ? evt.runKind === 'agent' : currentTab === 'agent';
  if (inAgent) {
    appendAgentEntry('error', '⚠ ' + evt.message);
    if (evt.runKind === 'agent') setAgentStatus('error', 'Error');
  } else {
    const m = document.createElement('div');
    m.className = 'msg error';
    m.textContent = `⚠ ${evt.message}`;
    els.messages.appendChild(m);
    els.messages.scrollTop = els.messages.scrollHeight;
  }
  els.send.disabled = false;
}

function onRunEnd(evt) {
  els.send.disabled = false;
  if (evt.kind === 'agent') {
    shownRunActive = false;
    els.abort.hidden = true;
    hideAskUser();
    if (evt.error) {
      setAgentStatus('error', 'Stopped');
    } else {
      setAgentStatus('done', 'Done');
      if (evt.finalMessage?.content) {
        appendAgentEntry('final', '✓ Final answer', evt.finalMessage.content);
      }
    }
  } else {
    // chat ended; currentAssistantMsg becomes final.
    currentAssistantMsg = null;
  }
}

// ---------------------------------------------------------------------------
// Agent rendering
// ---------------------------------------------------------------------------

function appendAgentEntry(kind, head, body) {
  const e = document.createElement('div');
  e.className = `log-entry ${kind}`;
  const h = document.createElement('div');
  h.className = 'head';
  h.textContent = head;
  e.appendChild(h);
  if (body !== undefined) {
    const b = document.createElement('div');
    b.className = 'body';
    b.textContent = body;
    e.appendChild(b);
  }
  els.agentLog.appendChild(e);
  els.agentLog.scrollTop = els.agentLog.scrollHeight;
  return e;
}

function resetAgentView() {
  els.agentLog.innerHTML = '';
  setAgentStatus('idle', 'Idle');
  els.abort.hidden = true;
  els.focusBadge.hidden = true;
  els.focusBreadcrumb.hidden = true;
  els.focusBreadcrumb.innerHTML = '';
  hideAskUser();
  shownRunActive = false;
}

function onAgentFocus(evt) {
  const { tabId, frameId, url, title, history } = evt;
  if (tabId == null) {
    els.focusBadge.hidden = true;
    els.focusBreadcrumb.hidden = true;
    return;
  }
  const label = title || url || `Tab ${tabId}`;
  const frameLabel = (frameId && frameId !== 0) ? ` · frame ${frameId}` : '';
  els.focusTitle.textContent = label + frameLabel;
  els.focusBadge.hidden = false;
  els.focusBadge.title = url ? `${title || ''}\n${url}${frameLabel}` : label;
  els.focusBadge.dataset.tabId = String(tabId);

  // Breadcrumb of recent focus changes
  if (Array.isArray(history) && history.length) {
    els.focusBreadcrumb.innerHTML = '';
    history.forEach((h, i) => {
      if (i > 0) {
        const a = document.createElement('span');
        a.className = 'arrow';
        a.textContent = '›';
        els.focusBreadcrumb.appendChild(a);
      }
      const c = document.createElement('button');
      c.className = 'crumb' + (i === history.length - 1 ? ' current' : '');
      c.textContent = (h.title || h.url || `Tab ${h.tabId}`).slice(0, 40);
      c.title = h.url || '';
      c.dataset.tabId = String(h.tabId);
      c.addEventListener('click', () => {
        chrome.tabs.update(parseInt(c.dataset.tabId, 10), { active: true });
      });
      els.focusBreadcrumb.appendChild(c);
    });
    els.focusBreadcrumb.hidden = false;
  }
}

function onAgentToolCall(name, args) {
  // remove any streaming reasoning marker
  Array.from(els.agentLog.children).forEach((c) => c.classList.remove('streaming'));
  const argStr = JSON.stringify(args || {}, null, 2);
  const summary = summarizeTool(name, args);
  const e = appendAgentEntry('tool', `🔧 ${name}` + (summary ? ` — ${summary}` : ''), argStr);
  e.dataset.tool = name;
  e.dataset.args = argStr;
}

function onAgentToolResult(name, observation) {
  const entries = els.agentLog.querySelectorAll(`.log-entry.tool[data-tool="${cssEscape(name)}"]`);
  const entry = entries[entries.length - 1];
  const obsStr = JSON.stringify(observation, null, 2).slice(0, 2000);
  appendAgentEntry('observation', `↳ result`, obsStr);
  if (entry) entry.appendChild(makeResultLine('ok', observation));
}

function makeResultLine(kind, observation) {
  const line = document.createElement('div');
  line.className = 'action-line';
  const name = document.createElement('span');
  name.className = 'action-name';
  name.textContent = kind === 'ok' ? 'ok' : (kind === 'err' ? 'err' : 'log');
  line.appendChild(name);
  const txt = document.createElement('span');
  txt.className = 'action-result';
  txt.textContent = JSON.stringify(observation).slice(0, 500);
  line.appendChild(txt);
  return line;
}

function summarizeTool(name, args) {
  try {
    if (name === 'browser_click') return `ref ${args.ref}`;
    if (name === 'browser_type') return `ref ${args.ref}, ${args.text?.length || 0} chars`;
    if (name === 'browser_navigate') return args.url;
    if (name === 'browser_new_tab') return args.url;
    if (name === 'browser_switch_tab') return `tab ${args.tabId}`;
    if (name === 'browser_press_key') return args.key;
    if (name === 'browser_send_keys') return (args.text || '').split('\n')[0].slice(0, 60);
    if (name === 'browser_scroll') return `${args.direction} ${args.amount || ''}`;
    if (name === 'browser_extract') return args.selector;
    if (name === 'browser_done') return (args.result || '').slice(0, 80);
    if (name === 'browser_ask_user') return (args.question || '').slice(0, 80);
  } catch {}
  return '';
}

function setAgentStatus(kind, label) {
  els.agentStatus.querySelectorAll('.dot').forEach((d) => d.className = `dot ${kind}`);
  els.agentStatus.querySelector('.label').textContent = label;
}

function showAskUser(question, focus = true) {
  els.askQ.textContent = question;
  els.askUserRow.hidden = false;
  if (focus) els.askInput.focus();
  setAgentStatus('running', 'Waiting for you');
}

function hideAskUser() {
  els.askUserRow.hidden = true;
  els.askInput.value = '';
}

function cssEscape(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

// Agents running in other tabs, with a shortcut to jump to each.
function renderOtherRuns() {
  const others = activeRuns.filter((r) => r.ownerTabId !== currentAgentOwner);
  els.otherRuns.innerHTML = '';
  if (!others.length) {
    els.otherRuns.hidden = true;
    return;
  }
  const label = document.createElement('span');
  label.textContent = others.length === 1 ? 'Also running in 1 other tab:' : `Also running in ${others.length} other tabs:`;
  els.otherRuns.appendChild(label);
  for (const r of others) {
    const b = document.createElement('button');
    b.className = 'crumb';
    b.textContent = (r.awaitingUser ? '? ' : '') + String(r.title || `Tab ${r.ownerTabId}`).slice(0, 30);
    b.title = r.awaitingUser ? 'Waiting for your reply' : 'Running';
    b.addEventListener('click', () => {
      chrome.tabs.update(r.ownerTabId, { active: true }).catch(() => {});
    });
    els.otherRuns.appendChild(b);
  }
  els.otherRuns.hidden = false;
}

// Initial state
updateInputPlaceholder();
els.send.disabled = false;

// ---------------------------------------------------------------------------
// Per-tab routing
// ---------------------------------------------------------------------------
//
// Every open Chrome tab owns one chat thread and at most one agent run. When
// the side panel opens we load the active tab's state; whenever the user
// activates a different tab we swap to that tab's state.

async function syncActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const id = tab?.id ?? null;
    if (id !== currentTabId) {
      currentTabId = id;
      if (id != null) {
        await loadTab(id);
      } else {
        renderThreadMessages([]);
        resetAgentView();
      }
    }
  } catch {}
}

async function loadTab(tabId) {
  const seq = ++loadSeq;
  let resp = null;
  try {
    resp = await chrome.runtime.sendMessage({ type: 'panel:load', tabId });
  } catch {}
  if (seq !== loadSeq) return; // the user already moved to another tab

  renderThreadMessages(resp?.messages || []);
  resetAgentView();
  const agent = resp?.agent;
  currentAgentOwner = agent?.run?.ownerTabId ?? tabId;
  if (agent) {
    for (const evt of agent.log || []) handleRunEvent(evt, true);
    const run = agent.run;
    shownRunActive = !run.finished;
    els.abort.hidden = run.finished;
    if (!run.finished) {
      if (run.awaitingUser) showAskUser(run.awaitingQuestion, false);
      else setAgentStatus('running', `Step ${run.step}`);
    }
  }
  if (resp?.runs) activeRuns = resp.runs;
  renderOtherRuns();
}

function renderThreadMessages(messages) {
  els.messages.innerHTML = '';
  currentAssistantMsg = null;
  for (const m of messages || []) {
    if (m.role === 'user') {
      appendMsg('user', m.content || '');
    } else if (m.role === 'assistant') {
      const node = appendMsg('assistant', m.content || '');
      // Mark the latest assistant as the "current" so any subsequent token
      // deltas append to it instead of creating a new bubble.
      currentAssistantMsg = { role: 'assistant', node, content: m.content || '' };
    }
  }
  els.messages.scrollTop = els.messages.scrollHeight;
}

function onTabActivated(tabId) {
  if (tabId == null || tabId === currentTabId) return;
  currentTabId = tabId;
  loadTab(tabId);
  refreshPageContext();
}

syncActiveTab();
window.addEventListener('focus', () => syncActiveTab());
