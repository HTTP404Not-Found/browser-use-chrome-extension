// lib/llm.js
// OpenAI-compatible streaming chat client with tool calling.
// Works with OpenAI, DeepSeek, OpenRouter, vLLM, Ollama (compat mode), etc.
//
// Reads API config from chrome.storage.local under key "llmConfig":
//   { apiKey, baseUrl, model, maxContextChars, contextWindowTokens, supportsVision, maxSteps }
//
// Message content may be a string or an OpenAI-style multimodal array of
// { type: 'text', text } and { type: 'image_url', image_url: { url } } parts,
// which vision models on OpenAI, OpenRouter, Gemini, Qwen-VL, vLLM and Ollama
// accept. Whether images are sent at all is decided by `supportsVision`.
//
// Exposes:
//   streamChat({ messages, tools, toolChoice, signal, onDelta, onToolCall, onDone, onError })
// Returns the final assistant message.

export const MIN_CONTEXT_WINDOW_TOKENS = 8000;
export const MAX_CONTEXT_WINDOW_TOKENS = 1000000;
// Rough request cost of one ~1280px image; OpenAI bills roughly 765–1105
// tokens for that size, other providers are in the same range.
export const IMAGE_TOKEN_ESTIMATE = 1100;

const DEFAULTS = {
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  // 0 = derive from the context window (see pageContextChars).
  maxContextChars: 0,
  contextWindowTokens: 128000,
  supportsVision: false,
  maxSteps: 40
};

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

function windowTokens(cfg) {
  const n = Number(cfg?.contextWindowTokens);
  return Number.isFinite(n) && n > 0
    ? clamp(Math.floor(n), MIN_CONTEXT_WINDOW_TOKENS, MAX_CONTEXT_WINDOW_TOKENS)
    : DEFAULTS.contextWindowTokens;
}

export async function getLlmConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['llmConfig'], (r) => {
      const cfg = { ...DEFAULTS, ...(r.llmConfig || {}) };
      cfg.contextWindowTokens = windowTokens(cfg);
      cfg.supportsVision = !!cfg.supportsVision;
      resolve(cfg);
    });
  });
}

export async function setLlmConfig(patch) {
  const cur = await getLlmConfig();
  const next = { ...cur, ...patch };
  return new Promise((resolve) => {
    chrome.storage.local.set({ llmConfig: next }, () => resolve(next));
  });
}

// ---------------------------------------------------------------------------
// Context budgeting
// ---------------------------------------------------------------------------

/**
 * Cheap token estimate for a string, a multimodal content array or a whole
 * message. ~3.5 characters per token for Latin text; CJK and other wide
 * characters count as one token each.
 */
export function estimateTokens(value) {
  if (value == null) return 0;
  if (typeof value === 'string') {
    let wide = 0;
    for (let i = 0; i < value.length; i++) if (value.charCodeAt(i) > 0x2e7f) wide++;
    return Math.ceil((value.length - wide) / 3.5 + wide);
  }
  if (Array.isArray(value)) {
    let n = 0;
    for (const part of value) {
      if (part?.type === 'image_url') n += IMAGE_TOKEN_ESTIMATE;
      else if (part?.type === 'text') n += estimateTokens(part.text);
      else n += estimateTokens(JSON.stringify(part));
    }
    return n;
  }
  if (typeof value === 'object') {
    let n = 4 + estimateTokens(value.content) + estimateTokens(value.reasoning_content);
    if (value.tool_calls) n += estimateTokens(JSON.stringify(value.tool_calls));
    return n;
  }
  return estimateTokens(String(value));
}

/** Tokens available for conversation history, leaving room for the tool
 *  schema, the system prompt and the reply. */
export function historyBudgetTokens(cfg) {
  return Math.max(6000, Math.floor(windowTokens(cfg) * 0.8) - 16000);
}

/** Largest single tool result kept in the conversation (characters). */
export function toolResultMaxChars(cfg) {
  return clamp(Math.floor(windowTokens(cfg) * 0.05 * 3), 12000, 150000);
}

/** Cap for one browser_page_text call (characters). */
export function pageTextMaxChars(cfg) {
  return clamp(Math.floor(windowTokens(cfg) * 0.1 * 3), 30000, 300000);
}

/** Page text attached to a chat message (characters). About a quarter of the
 *  window unless the user set a smaller explicit limit. */
export function pageContextChars(cfg) {
  const windowCap = Math.floor(windowTokens(cfg) * 0.25 * 3);
  const n = Number(cfg?.maxContextChars);
  return Number.isFinite(n) && n > 0 ? Math.min(n, windowCap) : windowCap;
}

/**
 * Stream a chat completion. Calls onDelta({content, reasoning}) for each text token,
 * collects tool calls into onToolCall(toolCalls) when finish_reason === 'tool_calls'.
 * Returns final assistant message.
 */
export async function streamChat({
  messages,
  tools,
  toolChoice = 'auto',
  signal,
  onDelta,
  onToolCall,
  onReasoningDelta,
  onDone,
  onError
}) {
  const cfg = await getLlmConfig();
  if (!cfg.apiKey) {
    const err = new Error('Missing API key. Open the extension options to set one.');
    onError?.(err);
    throw err;
  }

  const url = `${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const body = {
    model: cfg.model,
    messages,
    stream: true
  };
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = toolChoice;
  }

  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`
      },
      body: JSON.stringify(body),
      signal
    });
  } catch (e) {
    onError?.(e);
    throw e;
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    const err = new Error(`HTTP ${resp.status} ${resp.statusText}: ${text.slice(0, 300)}`);
    onError?.(err);
    throw err;
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let fullContent = '';
  let fullReasoning = '';
  /** @type {Map<number, {id:string,name:string,args:string}>} */
  const toolCalls = new Map();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') {
        // finalize tool calls
        const tcs = Array.from(toolCalls.values()).map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.args }
        }));
        if (tcs.length) onToolCall?.(tcs);
        const final = {
          role: 'assistant',
          content: fullContent,
          tool_calls: tcs.length ? tcs : undefined,
          reasoning_content: fullReasoning || undefined
        };
        onDone?.(final);
        return final;
      }
      let evt;
      try {
        evt = JSON.parse(data);
      } catch {
        continue;
      }
      const choice = evt.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta || {};
      if (delta.content) {
        fullContent += delta.content;
        onDelta?.(delta.content);
      }
      if (delta.reasoning_content) {
        fullReasoning += delta.reasoning_content;
        onReasoningDelta?.(delta.reasoning_content);
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const slot = toolCalls.get(tc.index) || { id: '', name: '', args: '' };
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.name += tc.function.name;
          if (tc.function?.arguments) slot.args += tc.function.arguments;
          toolCalls.set(tc.index, slot);
        }
      }
    }
  }
  // Stream ended without [DONE]
  const tcs = Array.from(toolCalls.values()).map((tc) => ({
    id: tc.id,
    type: 'function',
    function: { name: tc.name, arguments: tc.args }
  }));
  if (tcs.length) onToolCall?.(tcs);
  const final = {
    role: 'assistant',
    content: fullContent,
    tool_calls: tcs.length ? tcs : undefined,
    reasoning_content: fullReasoning || undefined
  };
  onDone?.(final);
  return final;
}

/** Truncate long page context to fit model context window. */
export function clipText(s, max = 80000) {
  if (!s) return '';
  if (s.length <= max) return s;
  return s.slice(0, max) + '\n\n[... content truncated ...]';
}
