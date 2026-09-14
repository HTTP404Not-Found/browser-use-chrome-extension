// options/options.js
import { getLlmConfig, setLlmConfig } from '../lib/llm.js';

const els = {
  apiKey: document.getElementById('api-key'),
  baseUrl: document.getElementById('base-url'),
  model: document.getElementById('model'),
  maxCtx: document.getElementById('max-ctx'),
  maxSteps: document.getElementById('max-steps'),
  showBadge: document.getElementById('show-badge'),
  save: document.getElementById('save'),
  test: document.getElementById('test'),
  status: document.getElementById('status')
};

async function load() {
  const cfg = await getLlmConfig();
  els.apiKey.value = cfg.apiKey || '';
  els.baseUrl.value = cfg.baseUrl || 'https://api.openai.com/v1';
  els.model.value = cfg.model || 'gpt-4o-mini';
  els.maxCtx.value = cfg.maxContextChars || 80000;
  els.maxSteps.value = cfg.maxSteps || 40;
  const { showBadge } = await chrome.storage.local.get(['showBadge']);
  els.showBadge.checked = !!showBadge;
}

async function save() {
  const patch = {
    apiKey: els.apiKey.value.trim(),
    baseUrl: els.baseUrl.value.trim() || 'https://api.openai.com/v1',
    model: els.model.value.trim() || 'gpt-4o-mini',
    maxContextChars: Math.max(4000, Math.min(200000, parseInt(els.maxCtx.value, 10) || 80000)),
    maxSteps: Math.max(5, Math.min(200, parseInt(els.maxSteps.value, 10) || 40))
  };
  await setLlmConfig(patch);
  await chrome.storage.local.set({ showBadge: !!els.showBadge.checked });
  setStatus('Saved.', 'ok');
}

async function testConn() {
  await save();
  setStatus('Testing…', '');
  const cfg = await getLlmConfig();
  if (!cfg.apiKey) {
    setStatus('No API key set.', 'err');
    return;
  }
  try {
    const resp = await fetch(`${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: 'user', content: 'Reply with the single word: pong' }],
        max_tokens: 8
      })
    });
    if (!resp.ok) {
      const t = await resp.text();
      setStatus(`Failed: HTTP ${resp.status} — ${t.slice(0, 200)}`, 'err');
      return;
    }
    setStatus('Connection OK ✓', 'ok');
  } catch (e) {
    setStatus(`Failed: ${String(e.message || e)}`, 'err');
  }
}

function setStatus(text, kind) {
  els.status.textContent = text;
  els.status.className = `status ${kind || ''}`.trim();
}

els.save.addEventListener('click', save);
els.test.addEventListener('click', testConn);
load();