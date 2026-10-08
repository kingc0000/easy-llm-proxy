/**
 * adapters.js — 上游请求与协议适配(openai/anthropic)
 * 对客户端始终暴露 OpenAI 兼容接口;anthropic provider 自动做请求/响应/流式双向转换
 */
'use strict';
const http = require('http');
const https = require('https');
const { Transform } = require('stream');

const TIMEOUT_MS = parseInt(process.env.TIMEOUT_MS || '120000', 10);
const SMALL_READ_LIMIT = 16 * 1024;

/* ---------- 路径 ---------- */
function chatPathOf(p) {
  if (p.apiPath) return p.apiPath;
  return p.apiType === 'anthropic' ? '/v1/messages' : '/v1/chat/completions';
}
function modelsPathOf() { return '/v1/models'; }

/* ---------- 请求头 ---------- */
function upstreamHeaders(p, key) {
  const h = {};
  if (p.apiType === 'anthropic') {
    h['x-api-key'] = key;
    h['anthropic-version'] = '2023-06-01';
    h['Content-Type'] = 'application/json';
  } else if (p.apiKeyHeader) {
    h[p.apiKeyHeader.toLowerCase()] = key;
    h['Content-Type'] = 'application/json';
  } else {
    h['Authorization'] = 'Bearer ' + key;
    h['Content-Type'] = 'application/json';
  }
  for (const [k, v] of Object.entries(p.extraHeaders || {})) h[k.toLowerCase()] = v;
  h['Accept'] = 'text/event-stream, application/json';
  return h;
}

/* ---------- body 转换 ---------- */
function toAnthropicBody(b) {
  const msgs = Array.isArray(b.messages) ? b.messages : [];
  const system = msgs
    .filter((m) => m.role === 'system')
    .map((m) => (Array.isArray(m.content) ? m.content.map((c) => c.text || '').join('') : String(m.content || '')))
    .join('\n');
  const out = {
    model: b.model,
    max_tokens: Number.isInteger(b.max_tokens) ? b.max_tokens : 4096,
    messages: msgs
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: Array.isArray(m.content) ? m.content.map((c) => c.text || '').join('') : String(m.content ?? ''),
      })),
  };
  if (system) out.system = system;
  if (b.temperature !== undefined) out.temperature = b.temperature;
  if (b.top_p !== undefined) out.top_p = b.top_p;
  if (b.stream) out.stream = true;
  return out;
}

/** 改写请求体中的 model(降级切换时用),保持剩余字段 */
function setModel(body, modelId) {
  const j = JSON.parse(body.toString('utf8'));
  j.model = modelId;
  return Buffer.from(JSON.stringify(j));
}

/* ---------- 响应转换 ---------- */
function anthropicToOpenAIResp(b, model) {
  const content = (Array.isArray(b.content) ? b.content : []).map((c) => (c.type === 'text' ? c.text : '')).join('');
  const stop = b.stop_reason === 'end_turn' || b.stop_reason === 'stop_sequence' ? 'stop' : (b.stop_reason || null);
  const usage = b.usage || {};
  return {
    id: b.id || ('chatcmpl-' + Math.random().toString(36).slice(2, 10)),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: b.model || model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: stop }],
    usage: { prompt_tokens: usage.input_tokens || 0, completion_tokens: usage.output_tokens || 0, total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0) },
  };
}

/** 从非流式响应 body 提取真实 usage → {prompt, cached, completion} */
function usageOf(body, apiType) {
  try {
    const j = JSON.parse(body.toString('utf8'));
    if (!j || !j.usage) return null;
    const u = j.usage;
    if (apiType === 'anthropic') {
      // Anthropic 的 input_tokens 不含缓存(cache_read/cache_creation 另计) → 补齐成"总输入(含缓存)"
      return {
        prompt: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
        cached: u.cache_read_input_tokens || 0,
        completion: u.output_tokens || 0,
      };
    }
    return {
      prompt: u.prompt_tokens || 0,
      cached: (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0,
      completion: u.completion_tokens || 0,
    };
  } catch { return null; }
}

/**
 * 从流式数据滑动窗口提取所有 usage 候选(数组):
 *  1) SSE 事件: 顶层 usage(openai 末 chunk) + message.usage(anthropic message_start)
 *  2) JSON 响应中的 "usage": {...} 对象(括号平衡截取)
 * 注意: anthropic 流式 start(输入/缓存)与 delta(输出)分两次到达,都须收集,
 *       字段级去重由调用方(proxy)按"每字段首现值"处理。
 */
function extractUsages(buf) {
  const out = [];
  const s = buf.toString('utf8');
  for (const line of s.split('\n')) {
    const m = line.match(/^data:\s*(\{.*\})\s*$/);
    if (m) {
      try {
        const j = JSON.parse(m[1]);
        if (j && j.usage) out.push(j.usage);
        if (j && j.message && j.message.usage) out.push(j.message.usage);
      } catch {}
    }
  }
  const i = s.lastIndexOf('"usage"');
  if (i !== -1) {
    const j = s.indexOf('{', i);
    if (j !== -1) {
      const slice = s.slice(j);
      let depth = 0;
      for (let k = 0; k < slice.length; k++) {
        if (slice[k] === '{') depth++;
        else if (slice[k] === '}') { depth--; if (depth === 0) { try { out.push(JSON.parse(slice.slice(0, k + 1))); } catch {} break; } }
      }
    }
  }
  return out;
}

/** usage 归一化为 stats 字段: 按"出现哪些键"判 anthropic/openai 格式 */
function normUsage(u) {
  if (!u) return null;
  if ('input_tokens' in u || 'output_tokens' in u || 'cache_read_input_tokens' in u || 'cache_creation_input_tokens' in u) {
    return {
      // Anthropic: input_tokens 不含缓存 → 总输入 = input + cache_read + cache_creation
      prompt: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
      cached: u.cache_read_input_tokens || 0,
      completion: u.output_tokens || 0,
    };
  }
  return { prompt: u.prompt_tokens || 0, cached: (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0, completion: u.completion_tokens || 0 };
}

/** anthropic SSE → openai SSE(流式实时转换);token 统计由 proxy 层窗口监听统一处理 */
function anthropicSseToOpenAI(model) {
  let buffer = '';
  let started = false;
  let finished = false;
  const created = Math.floor(Date.now() / 1000);
  const base = { id: 'chatcmpl-' + Math.random().toString(36).slice(2, 10), object: 'chat.completion.chunk', created, model };
  return new Transform({
    transform(chunk, _enc, cb) {
      buffer += chunk.toString('utf8');
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const dataLine = block.split('\n').find((l) => l.startsWith('data:'));
        if (!dataLine) continue;
        let evt;
        try { evt = JSON.parse(dataLine.slice(5).trim()); } catch { continue; }
        if (finished) continue;
        if (evt.type === 'message_start') {
          started = true;
          this.push(JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }) + '\n\n');
        } else if (evt.type === 'content_block_delta' && evt.delta && evt.delta.type === 'text_delta') {
          if (started) this.push(JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: evt.delta.text }, finish_reason: null }] }) + '\n\n');
        } else if (evt.type === 'message_delta') {
          finished = true;
          this.push(JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n');
        }
      }
      cb();
    },
    flush(cb) {
      if (!finished) this.push(JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n');
      this.push('data: [DONE]\n\n');
      cb();
    },
  });
}

/* ---------- 上游请求 ---------- */
function attempt(provider, key, path, method, payload) {
  return new Promise((resolve) => {
    let base = String(provider.baseURL || '').replace(/\/+$/, '');
    const p = path.startsWith('/') ? path : '/' + path; // 防 apiPath 无前导斜杠错位
    const ver = base.match(/\/v\d+(?:beta)?$/); // baseURL 已带 /v1(或 /v1beta)时避免双拼
    if (ver && p.startsWith(ver[0])) base = base.slice(0, -ver[0].length);
    const up = new URL(base + p);
    const isHttps = up.protocol === 'https:';
    const opts = {
      hostname: up.hostname,
      port: up.port || (isHttps ? 443 : 80),
      path: up.pathname + up.search,
      method,
      headers: upstreamHeaders(provider, key),
      timeout: TIMEOUT_MS,
    };
    if (payload) opts.headers['Content-Length'] = Buffer.byteLength(payload);
    const reqFn = isHttps ? https.request : http.request;
    const ureq = reqFn(opts, (ures) => resolve({ status: ures.statusCode, headers: ures.headers, stream: ures, error: null }));
    ureq.on('timeout', () => ureq.destroy(Object.assign(new Error('upstream timeout'), { code: 'ETIMEDOUT' })));
    ureq.on('error', (e) => resolve({ status: 0, headers: {}, stream: null, body: Buffer.alloc(0), error: e }));
    if (payload) ureq.write(payload);
    ureq.end();
  });
}

/* ---------- 小体读取与决策 ---------- */
function consumeSmall(stream, limit) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    const onData = (c) => {
      chunks.push(c);
      size += c.length;
      if (size >= limit) { stream.removeListener('data', onData); done(); } // 只摘自己的监听
    };
    const done = () => { try { stream.destroy(); } catch {} resolve(Buffer.concat(chunks)); };
    stream.on('data', onData);
    stream.on('end', done);
    stream.on('error', done);
  });
}

function isRetriable(status) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504 || status === 0;
}

function parseBody(body) {
  if (!body) return null;
  try { return JSON.parse(body.toString('utf8')); } catch { return null; }
}

function isModelIssue(status, respBody) {
  if (status === 429 || status >= 500) return true;
  if (status >= 400 && status < 500) {
    const t = respBody ? respBody.toString('utf8') : '';
    return /model.{0,50}(not found|not available|unavailable|does not exist|not support|invalid)|is not available|"code"\s*[:"]\s*"?7|insufficient_quota|tpm\/rpm/i.test(t);
  }
  return false;
}

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
function filterHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

/** 决策: ok / final / retry */
async function decide(result) {
  if (result.error) return { kind: 'retry', reason: `net:${result.error.code || result.error.message}` };
  const st = result.status;
  if (st >= 200 && st < 300) return { kind: 'ok' };
  result.body = await consumeSmall(result.stream, SMALL_READ_LIMIT);
  result.stream.destroy();
  if (isRetriable(st)) return { kind: 'retry', reason: `status:${st}` };
  if (isModelIssue(st, result.body)) return { kind: 'retry', reason: `model:${st}` };
  return { kind: 'final' };
}

module.exports = {
  chatPathOf, modelsPathOf, toAnthropicBody, setModel, anthropicToOpenAIResp,
  anthropicSseToOpenAI, attempt, consumeSmall, decide, filterHeaders, parseBody, isModelIssue,
  usageOf, extractUsages, normUsage,
};