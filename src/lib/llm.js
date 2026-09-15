// lib/llm.js
// OpenAI-compatible streaming chat client with tool calling.
// Works with OpenAI, DeepSeek, OpenRouter, vLLM, Ollama (compat mode), etc.
//
// Reads API config from chrome.storage.local under key "llmConfig":
//   { apiKey, baseUrl, model, maxContextChars }
//
// Exposes:
//   streamChat({ messages, tools, toolChoice, signal, onDelta, onToolCall, onDone, onError })
// Returns the final assistant message.

const DEFAULTS = {
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  maxContextChars: 80000,
  maxSteps: 40
};

export async function getLlmConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['llmConfig'], (r) => {
      const cfg = r.llmConfig || {};
      resolve({ ...DEFAULTS, ...cfg });
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