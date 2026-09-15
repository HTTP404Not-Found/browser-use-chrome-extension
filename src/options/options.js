// options/options.js
import { getLlmConfig, setLlmConfig, MIN_CONTEXT_WINDOW_TOKENS, MAX_CONTEXT_WINDOW_TOKENS } from '../lib/llm.js';

const els = {
  apiKey: document.getElementById('api-key'),
  baseUrl: document.getElementById('base-url'),
  model: document.getElementById('model'),
  ctxPreset: document.getElementById('ctx-preset'),
  ctxWindow: document.getElementById('ctx-window'),
  vision: document.getElementById('vision'),
  maxCtx: document.getElementById('max-ctx'),
  maxSteps: document.getElementById('max-steps'),
  showBadge: document.getElementById('show-badge'),
  save: document.getElementById('save'),
  test: document.getElementById('test'),
  status: document.getElementById('status')
};

function syncPreset() {
  const v = String(parseInt(els.ctxWindow.value, 10));
  const match = Array.from(els.ctxPreset.options).some((o) => o.value === v);
  els.ctxPreset.value = match ? v : 'custom';
}

els.ctxPreset.addEventListener('change', () => {
  if (els.ctxPreset.value !== 'custom') els.ctxWindow.value = els.ctxPreset.value;
  else els.ctxWindow.focus();
});
els.ctxWindow.addEventListener('input', syncPreset);

async function load() {
  const cfg = await getLlmConfig();
  els.apiKey.value = cfg.apiKey || '';
  els.baseUrl.value = cfg.baseUrl || 'https://api.openai.com/v1';
  els.model.value = cfg.model || 'gpt-4o-mini';
  els.ctxWindow.value = cfg.contextWindowTokens;
  syncPreset();
  els.vision.checked = !!cfg.supportsVision;
  const mc = Number(cfg.maxContextChars);
  els.maxCtx.value = Number.isFinite(mc) && mc > 0 ? String(mc) : '0';
  // Show 0 (Unlimited) when the stored value is missing / non-positive.
  const ms = Number(cfg.maxSteps);
  els.maxSteps.value = Number.isFinite(ms) && ms > 0 ? String(ms) : '0';
  const { showBadge } = await chrome.storage.local.get(['showBadge']);
  els.showBadge.checked = !!showBadge;
}

async function save() {
  const windowTokens = parseInt(els.ctxWindow.value, 10);
  const pageChars = parseInt(els.maxCtx.value, 10);
  const patch = {
    apiKey: els.apiKey.value.trim(),
    baseUrl: els.baseUrl.value.trim() || 'https://api.openai.com/v1',
    model: els.model.value.trim() || 'gpt-4o-mini',
    contextWindowTokens: Number.isFinite(windowTokens)
      ? Math.max(MIN_CONTEXT_WINDOW_TOKENS, Math.min(MAX_CONTEXT_WINDOW_TOKENS, windowTokens))
      : 128000,
    supportsVision: !!els.vision.checked,
    // 0 / blank -> automatic, derived from the context window.
    maxContextChars: Number.isFinite(pageChars) && pageChars > 0 ? Math.max(4000, Math.min(4000000, pageChars)) : 0,
    // 0 / blank / negative -> unlimited (background treats <=0 as Infinity).
    maxSteps: (() => {
      const n = parseInt(els.maxSteps.value, 10);
      if (!Number.isFinite(n) || n <= 0) return 0;
      return n;
    })()
  };
  await setLlmConfig(patch);
  await chrome.storage.local.set({ showBadge: !!els.showBadge.checked });
  els.ctxWindow.value = patch.contextWindowTokens;
  syncPreset();
  setStatus('Saved.', 'ok');
}

async function chatCompletion(cfg, messages) {
  const resp = await fetch(`${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`
    },
    body: JSON.stringify({ model: cfg.model, messages, max_tokens: 16 })
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`HTTP ${resp.status} — ${t.slice(0, 200)}`);
  }
  const data = await resp.json().catch(() => null);
  return String(data?.choices?.[0]?.message?.content || '').trim();
}

// A small solid red square, to check that the endpoint accepts image input.
function testImageDataUrl() {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ff0000';
  ctx.fillRect(0, 0, 64, 64);
  return canvas.toDataURL('image/png');
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
    await chatCompletion(cfg, [{ role: 'user', content: 'Reply with the single word: pong' }]);
  } catch (e) {
    setStatus(`Failed: ${String(e.message || e)}`, 'err');
    return;
  }
  if (!cfg.supportsVision) {
    setStatus('Connection OK ✓', 'ok');
    return;
  }
  setStatus('Connection OK ✓ — testing image input…', 'ok');
  try {
    const answer = await chatCompletion(cfg, [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What color is this square? Answer with one word.' },
          { type: 'image_url', image_url: { url: testImageDataUrl() } }
        ]
      }
    ]);
    setStatus(`Connection OK ✓ · image input accepted ✓ (the model answered: "${answer.slice(0, 40)}")`, 'ok');
  } catch (e) {
    setStatus(
      `Text works, but image input failed: ${String(e.message || e)}. This model or endpoint probably does not accept images — turn off "Model supports images" or pick a vision model.`,
      'err'
    );
  }
}

function setStatus(text, kind) {
  els.status.textContent = text;
  els.status.className = `status ${kind || ''}`.trim();
}

els.save.addEventListener('click', save);
els.test.addEventListener('click', testConn);
load();
