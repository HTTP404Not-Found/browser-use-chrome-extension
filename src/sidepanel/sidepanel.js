// sidepanel/sidepanel.js
// Wires up the chat and agent views. Communicates with the background SW via
// a long-lived port (chrome.runtime.connect) so we can render streamed tokens
// and live agent events.

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
let currentAgentRun = null;

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

port.onMessage.addListener((evt) => {
  switch (evt.type) {
    case 'run:start':
      onRunStart(evt);
      break;
    case 'token':
      onToken(evt.content);
      break;
    case 'reasoning':
      // Skip showing reasoning tokens (they waste space). Could be enabled later.
      break;
    case 'agent:step':
      onAgentStep(evt.step);
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
      showAskUser(evt.question);
      break;
    case 'error':
      onError(evt.message);
      break;
    case 'run:end':
      onRunEnd(evt);
      break;
  }
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
  els.messages.innerHTML = '';
  els.agentLog.innerHTML = '';
  currentAssistantMsg = null;
  setAgentStatus('idle', 'Idle');
  els.abort.hidden = true;
  els.focusBadge.hidden = true;
  els.focusBreadcrumb.hidden = true;
  els.focusBreadcrumb.innerHTML = '';
  hideAskUser();
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
  port.postMessage({ type: 'abort' });
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
  if (!text) return;
  port.postMessage({ type: 'agent:userReply', text });
  appendAskHistory(text);
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
  els.input.value = '';
  els.send.disabled = true;

  if (currentTab === 'chat') {
    appendMsg('user', text);
    const page = await getPageContext();
    port.postMessage({ type: 'chat:send', userText: text, page, conversationId: Date.now() });
  } else {
    appendAgentEntry('final', `▶ Task: ${text}`);
    const page = await getPageContext();
    port.postMessage({ type: 'agent:start', task: text, page });
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
    els.abort.hidden = false;
    setAgentStatus('running', evt.resume ? 'Resuming…' : 'Starting…');
  } else {
    currentAssistantMsg = null;
    setAgentStatus('idle', 'Idle'); // n/a for chat
  }
  hideAskUser();
}

function onToken(content) {
  if (currentTab !== 'chat') {
    // In agent view, also append token to the latest assistant msg if no tool call
    // For simplicity we just append to a streaming log entry.
    const last = els.agentLog.lastElementChild;
    if (last && last.classList.contains('streaming')) {
      last.querySelector('.body').textContent += content;
      els.agentLog.scrollTop = els.agentLog.scrollHeight;
    } else {
      const e = appendAgentEntry('observation', 'Reasoning');
      e.classList.add('streaming');
      e.querySelector('.body').textContent = content;
      els.agentLog.scrollTop = els.agentLog.scrollHeight;
    }
    return;
  }
  const node = ensureAssistantMsg();
  node.textContent += content;
  currentAssistantMsg.content = node.textContent;
  els.messages.scrollTop = els.messages.scrollHeight;
}

function onError(message) {
  if (currentTab === 'chat') {
    const m = document.createElement('div');
    m.className = 'msg error';
    m.textContent = `⚠ ${message}`;
    els.messages.appendChild(m);
  } else {
    appendAgentEntry('error', '⚠ ' + message);
  }
  els.send.disabled = false;
  els.abort.hidden = true;
  setAgentStatus('error', 'Error');
}

function onRunEnd(evt) {
  els.send.disabled = false;
  els.abort.hidden = true;
  if (evt.kind === 'agent') {
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

function onAgentStep(step) {
  setAgentStatus('running', `Step ${step}`);
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
  const e = appendAgentEntry('observation', `↳ result`, obsStr);
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

function showAskUser(question) {
  els.askQ.textContent = question;
  els.askUserRow.hidden = false;
  els.askInput.focus();
  setAgentStatus('running', 'Waiting for you');
}

function hideAskUser() {
  els.askUserRow.hidden = true;
  els.askInput.value = '';
}

function cssEscape(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

// Initial state
updateInputPlaceholder();
els.send.disabled = false;
chrome.runtime.sendMessage({ type: 'noop' }, () => {});