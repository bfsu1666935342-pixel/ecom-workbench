'use strict';

const DEFAULT_TIMEOUT = 10 * 60 * 1000;

class ApiError extends Error {
  constructor(status, message, body) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

function parseApiError(status, text) {
  let message = text;
  try {
    const obj = JSON.parse(text);
    if (obj && obj.error) message = obj.error.message || obj.error.type || text;
  } catch {
    /* keep raw text */
  }
  if (typeof message !== 'string') message = String(message);
  return new ApiError(status, message.slice(0, 800), text);
}

function headers(apiKey) {
  return {
    Authorization: 'Bearer ' + apiKey,
    'Content-Type': 'application/json',
  };
}

async function verifyKey({ apiKey, baseUrl }) {
  const resp = await fetch(baseUrl + '/models', {
    headers: { Authorization: 'Bearer ' + apiKey },
    signal: AbortSignal.timeout(20000),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw parseApiError(resp.status, text);
  }
  return true;
}

/**
 * Stream one chat completion.
 * Callbacks: onDelta(text), onReasoning(text), onToolCallDelta(), onUsage(usage)
 * Resolves to { text, reasoning, toolCalls, finishReason, usage }
 */
async function streamChat(opts) {
  const {
    apiKey,
    baseUrl,
    model,
    messages,
    tools = [],
    thinking = false,
    signal,
    onDelta,
    onReasoning,
    onUsage,
  } = opts;

  const body = {
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    thinking: { type: thinking ? 'enabled' : 'disabled' },
  };
  if (tools.length) body.tools = tools;

  const timeout = AbortSignal.timeout(DEFAULT_TIMEOUT);
  const merged = signal ? AbortSignal.any([signal, timeout]) : timeout;

  const resp = await fetch(baseUrl + '/chat/completions', {
    method: 'POST',
    headers: headers(apiKey),
    body: JSON.stringify(body),
    signal: merged,
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw parseApiError(resp.status, text);
  }
  if (!resp.body) throw new ApiError(502, '上游没有返回内容');

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let reasoning = '';
  let finishReason = null;
  let usage = null;
  const calls = new Map();

  const handleEvent = (payload) => {
    if (!payload || payload === '[DONE]') return;
    let obj;
    try {
      obj = JSON.parse(payload);
    } catch {
      return;
    }
    if (obj.error) {
      throw new ApiError(502, obj.error.message || '生成失败', payload);
    }
    if (obj.usage) {
      usage = obj.usage;
      if (onUsage) onUsage(obj.usage);
    }
    const choice = obj.choices && obj.choices[0];
    if (!choice) return;
    const delta = choice.delta || {};

    if (delta.reasoning_content) {
      reasoning += delta.reasoning_content;
      if (onReasoning) onReasoning(delta.reasoning_content);
    }
    if (delta.content) {
      text += delta.content;
      if (onDelta) onDelta(delta.content);
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = Number.isInteger(tc.index) ? tc.index : 0;
        let cur = calls.get(idx);
        if (!cur) {
          cur = { id: '', name: '', arguments: '' };
          calls.set(idx, cur);
        }
        if (tc.id) cur.id = tc.id;
        const fn = tc.function || {};
        if (fn.name) cur.name += fn.name;
        if (fn.arguments) cur.arguments += fn.arguments;
      }
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        if (!line || line.startsWith(':')) continue;
        if (line.startsWith('data:')) {
          handleEvent(line.slice(5).trim());
        }
      }
    }
    if (buffer.trim().startsWith('data:')) {
      handleEvent(buffer.trim().slice(5).trim());
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }

  const toolCalls = [...calls.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v], i) => ({ id: v.id || 'call_' + i, name: v.name, arguments: v.arguments || '{}' }));

  return { text, reasoning, toolCalls, finishReason, usage };
}

async function search({ apiKey, baseUrl, query, count = 8 }) {
  const resp = await fetch(baseUrl + '/v1/tools/search', {
    method: 'POST',
    headers: headers(apiKey),
    body: JSON.stringify({ query, count, need_content: false }),
    signal: AbortSignal.timeout(60000),
  });
  if (!resp.ok) throw parseApiError(resp.status, await resp.text());
  const data = await resp.json();
  return Array.isArray(data.results) ? data.results : [];
}

async function fetchUrl({ apiKey, baseUrl, url }) {
  const resp = await fetch(baseUrl + '/v1/tools/fetch', {
    method: 'POST',
    headers: headers(apiKey),
    body: JSON.stringify({ url }),
    signal: AbortSignal.timeout(90000),
  });
  if (!resp.ok) throw parseApiError(resp.status, await resp.text());
  return resp.json();
}

async function uploadFile({ apiKey, baseUrl, buffer, filename, mime, purpose }) {
  const form = new FormData();
  form.append('purpose', purpose);
  form.append('file', new Blob([buffer], { type: mime || 'application/octet-stream' }), filename);
  const resp = await fetch(baseUrl + '/files', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + apiKey },
    body: form,
    signal: AbortSignal.timeout(5 * 60 * 1000),
  });
  if (!resp.ok) throw parseApiError(resp.status, await resp.text());
  return resp.json();
}

module.exports = { streamChat, search, fetchUrl, uploadFile, verifyKey, ApiError };
