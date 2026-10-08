/**
 * proxy.js — 主代理转发链(权重轮询引擎的请求执行)
 *
 * 职责: /v1/chat/completions 尝试链(plan → 逐候选转发 → 降级/冷却状态维护)
 *      + /v1/models 列表 + 通用工具(json/shortKey)与每 provider 引擎状态。
 * 拆分: HTTP 服务器与路由分发见 server.js;管理 API(/api/*)见 api.js。
 */
'use strict';
const config = require('./config');
const balance = require('./balance');
const stats = require('./stats');
const ad = require('./adapters');
const requests = require('./requests');

const startTime = Date.now();

/* 每 provider 的权重引擎状态(内存,跨请求) */
const states = new Map();
function stateOf(provider) {
  if (!states.has(provider.name)) states.set(provider.name, balance.newState());
  return states.get(provider.name);
}

/* 混合轮询游标(不指定 provider 时) */
let ppick = 0;

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function shortKey(key) {
  if (typeof key !== 'string' || key.length <= 12) return key || '(empty)';
  return key.slice(0, 8) + '…' + key.slice(-4);
}

/* ---------------- chat 处理(权重引擎) ---------------- */

/**
 * 构造一次上游尝试的请求路径与 body:
 *  - 配置内降级/切换时改写请求体 model(passThrough 永远透传原 model)
 *  - anthropic provider 做 body 转换(OpenAI → Anthropic 格式)
 */
function prepUpstream(provider, pathname, body, c, requestedModel, passThrough) {
  const upPath = provider.apiPath ? provider.apiPath : (provider.apiType === 'anthropic' ? '/v1/messages' : pathname);
  let payload = body;
  if (passThrough === false && requestedModel && c.modelId !== requestedModel) payload = ad.setModel(body, c.modelId);
  let upPayload = payload;
  if (provider.apiType === 'anthropic' && payload) {
    const j = ad.parseBody(payload);
    if (j) upPayload = Buffer.from(JSON.stringify(ad.toAnthropicBody(j)));
  }
  return { upPath, upPayload };
}

async function handleChat(req, res, pathname, method, body, pick) {
  const cfg = config.load();
  if (!cfg.providers.length) return json(res, 503, { error: { message: `proxy: 无可用 provider (${config.CONFIG_FILE})` } });

  let provider;
  const want = pick || cfg.defaultProvider;
  if (want) {
    provider = cfg.providers.find((p) => p.name === want);
    if (!provider) return json(res, 400, { error: { message: `proxy: provider "${want}" 不存在` } });
  } else {
    provider = cfg.providers[ppick % cfg.providers.length];
    ppick++;
  }

  const parsed = ad.parseBody(body);
  const requestedModel = (parsed && parsed.model) || null;
  // 请求 model 是否在配置中: 在 → 权重引擎(可降级);不在 → 透传原 model + 主 key 池(仅换 key,不跨 model 降级)
  const confModel = requestedModel ? provider.models.some((m) => m.id === requestedModel) : false;
  const passThrough = !!requestedModel && !confModel;
  const st = stateOf(provider);
  const mainId = balance.mainModel(provider).id;
  // 生成尝试计划;同时 diff per-key 降级态,到期自动清理的 key 记「降级恢复」事件
  const rePlan = (rid) => {
    const before = new Map(st.degraded);
    const pl = balance.plan(provider, st, rid);
    for (const [k, v] of before) {
      if (!st.degraded.has(k)) stats.recordEvent({ type: 'recover', provider: provider.name, model: v.modelId, key: shortKey(k), reason: '达限/到期 切回主' });
    }
    return pl;
  };
  let planList = confModel
    ? rePlan(requestedModel)
    : rePlan(null).filter((c) => c.modelId === mainId); // 只用主 model 的 key 池
  const cap = balance.maxAttempts(provider);
  let attempts = 0;
  let planIdx = 0;
  let degradeCount = 0;
  let lastResult = null;

  // 调用日志记录(原始请求/原始返回/错误;流式响应按 chunks 累积,结束时落盘)
  const rec = {
    t: Date.now(), provider: provider.name, apiType: provider.apiType,
    model: requestedModel, usedModel: null, key: null,
    status: null, ms: 0, attempts: 0, degraded: false, error: null,
    promptTokens: 0, cachedTokens: 0, completionTokens: 0,
    req: parsed, res: null, resChunks: [], truncated: false, logged: false,
  };
  let resBytes = 0;

  while (attempts < cap) {
    const c = planList[planIdx];
    if (!c) break;
    planIdx++;
    attempts++;

    // 构造本次尝试的上游请求(降级切换改写 model + anthropic body 转换)
    const { upPath, upPayload } = prepUpstream(provider, pathname, body, c, requestedModel, passThrough);

    const t0 = Date.now();
    const result = await ad.attempt(provider, c.key, upPath, method, upPayload);
    stats.markLatency(provider.name, c.modelId, c.key, Date.now() - t0);
    const s = stats.bump(provider.name, c.modelId, c.key, 'requests');
    if (upPayload) s.inputBytes += Buffer.byteLength(upPayload);
    const d = await ad.decide(result);
    lastResult = result;
    if (d.kind !== 'ok') stats.markError(provider.name, c.modelId, c.key, errTypeOf(d));

    if (d.kind === 'ok') {
      const ok = stats.bump(provider.name, c.modelId, c.key, 'ok');
      rec.usedModel = c.modelId; rec.key = shortKey(c.key); rec.status = result.status;
      rec.degraded = degradeCount > 0; rec.attempts = attempts;
      if (result.stream) {
        // 输出字节统计 + 真实 token(usage 滑动窗口: 覆盖 openai/anthropic 流式 SSE 与非流式 JSON)
        let win = Buffer.alloc(0);
        // 字段级去重: anthropic 流式 start(输入/缓存)与 delta(输出)分两次到达,
        // 每字段只记首次出现的值(兼容网关在 delta 重复回传 input_tokens 不双计)
        const got = {};
        result.stream.on('data', (ch) => {
          stats.bump(provider.name, c.modelId, c.key, 'outputBytes', ch.length);
          win = Buffer.concat([win, ch]).slice(-8192);
          const add = {};
          for (const u of ad.extractUsages(win)) {
            const n = ad.normUsage(u);
            if (!n) continue;
            if (!got.prompt && n.prompt) { got.prompt = 1; add.prompt = n.prompt; }
            if (!got.cached && n.cached) { got.cached = 1; add.cached = n.cached; }
            if (!got.completion && n.completion) { got.completion = 1; add.completion = n.completion; }
          }
          if (Object.keys(add).length) {
            stats.markTokens(provider.name, c.modelId, c.key, add);
            if (add.prompt) rec.promptTokens = add.prompt;         // 字段级首次值同步到日志
            if (add.cached) rec.cachedTokens = add.cached;
            if (add.completion) rec.completionTokens = add.completion;
          }
          // 原始返回累积(截断上限)
          if (resBytes < requests.MAX_REC) { rec.resChunks.push(ch); resBytes += ch.length; }
          else rec.truncated = true;
        });
        result.stream.on('end', () => logRec(rec)); // 流式响应完整结束才落盘
      } else if (result.body) {
        ok.outputBytes += result.body.length;
        const u = ad.usageOf(result.body, provider.apiType);
        if (u) {
          stats.markTokens(provider.name, c.modelId, c.key, u);
          if (u.prompt) rec.promptTokens = u.prompt;
          if (u.cached) rec.cachedTokens = u.cached;
          if (u.completion) rec.completionTokens = u.completion;
        }
        if (rec.res === null) { rec.res = result.body.toString('utf8'); logRec(rec); } // openai 非流式直接记录
      }
      balance.report(provider, st, c.modelId, c.key, true);
      return outputOk(res, provider, result, parsed && parsed.stream, parsed && parsed.model, rec);
    }
    if (d.kind === 'final') {
      stats.bump(provider.name, c.modelId, c.key, 'errors');
      return outputFail(res, provider, result, 0, rec);
    }
    stats.bump(provider.name, c.modelId, c.key, 'retries');
    balance.advanceKey(st, c.modelId, c.key); // 失败 key 进入冷却期 → 冷却期内该候选跳过,过期后重新可用
    console.log(`[proxy] ${method} ${pathname} -> ${result.status || 'ERR'} | ${provider.name}/${c.modelId} key ${shortKey(c.key)} (${d.reason}) 尝试 ${attempts}/${cap}`);

    // retry: 该 model 的 key 已耗尽 → 降级重排(passThrough 模式不跨 model 降级,直接耗尽)
    const remainingOfModel = planList.slice(planIdx).filter((x) => x.modelId === c.modelId).length;
    if (remainingOfModel === 0) {
      if (passThrough) break; // 未配置的 model 只换 key,不降级(保持 v1 行为)
      const modelKeys = [...new Set(planList.filter((x) => x.modelId === c.modelId).map((x) => x.key))];
      const dg = balance.degrade(provider, st, c.modelId, modelKeys);
      stats.recordEvent({ type: 'degrade', provider: provider.name, model: c.modelId, toModel: dg.toModel, key: modelKeys.join(' '), reason: d.reason });
      if (!dg.toModel && dg.cleared > 0) { // 最低权重也失败 → 兜底回主(也记恢复事件)
        stats.recordEvent({ type: 'recover', provider: provider.name, model: c.modelId, key: modelKeys.join(' '), reason: '最低权重也失败 回主重试' });
      }
      degradeCount++;
      planList = rePlan(requestedModel);
      planIdx = 0;
      if (degradeCount > provider.models.length + 2) break; // 兜底防无限降级
    }
  }

  // 耗尽
  return outputFail(res, provider, lastResult, attempts, rec);
}

/** decide 结果 → 错误分类标签 */
function errTypeOf(d) {
  const r = String(d && d.reason || '');
  if (r.startsWith('status:429')) return '429';
  if (r.startsWith('status:50')) return '5xx';
  if (r.startsWith('net:ETIMEDOUT')) return 'timeout';
  if (r.startsWith('net:')) return 'net';
  if (r.startsWith('model')) return 'model';
  return 'other';
}

/* ---------- 调用日志辅助(模块级,供 outputOk/outputFail 使用) ---------- */

/** 收尾: 串化响应/截断/填充耗时;返回可写日志的记录 */
function finalizeRec(rec) {
  rec.ms = Date.now() - rec.t;
  if (rec.resChunks && rec.resChunks.length) rec.res = Buffer.concat(rec.resChunks).toString('utf8');
  if (rec.res && rec.res.length > requests.MAX_REC) { rec.truncated = true; rec.res = rec.res.slice(0, requests.MAX_REC); }
  try { if (rec.req && JSON.stringify(rec.req).length > requests.MAX_REQ) { rec.reqTruncated = true; rec.req = null; } } catch { rec.req = null; }
  delete rec.resChunks;
  return rec;
}

/** 写日志(防重复) */
function logRec(rec) {
  if (rec && !rec.logged) { rec.logged = true; requests.log(finalizeRec(rec)); }
}

function outputOk(res, provider, result, isStream, model, rec) {
  if (result.error) return json(res, 502, { error: { message: `proxy: upstream error ${result.error.code || result.error.message}` } });
  const noteClose = () => { // 客户端提前断开: 补记半截日志
    if (rec && !rec.logged) { rec.error = 'client closed'; rec.status = 0; logRec(rec); }
  };
  if (provider.apiType === 'anthropic') {
    const headers = ad.filterHeaders(result.headers);
    if (isStream) {
      headers['content-type'] = 'text/event-stream';
      res.writeHead(result.status, headers);
      const conv = ad.anthropicSseToOpenAI(model || 'unknown');
      result.stream.on('error', (e) => { console.error('[proxy] upstream stream error:', e.message); res.destroy(); });
      res.on('close', () => { result.stream.destroy(); noteClose(); });
      res.on('error', () => result.stream.destroy());
      return result.stream.pipe(conv).pipe(res);
    }
    return (async () => {
      const raw = await ad.consumeSmall(result.stream, 32 * 1024 * 1024); // 32MB 上限,避免大响应截断损坏
      if (rec && rec.res === null) { rec.res = raw.toString('utf8'); logRec(rec); } // 上游原始返回
      try {
        const j = JSON.parse(raw.toString('utf8'));
        headers['content-type'] = 'application/json';
        res.writeHead(result.status, headers);
        return res.end(JSON.stringify(ad.anthropicToOpenAIResp(j, j.model)));
      } catch {
        res.writeHead(result.status, headers);
        return res.end(raw);
      }
    })();
  }
  // openai: 直接透传(注册 error 防崩溃;客户端断连时销毁上游流防泄漏)
  res.writeHead(result.status, ad.filterHeaders(result.headers));
  result.stream.on('error', (e) => { console.error('[proxy] upstream stream error:', e.message); res.destroy(); });
  res.on('close', () => { result.stream.destroy(); noteClose(); });
  res.on('error', () => result.stream.destroy());
  return result.stream.pipe(res);
}

function outputFail(res, provider, result, attempts, rec) {
  if (result && result.error) {
    if (rec) { rec.status = 0; rec.error = result.error.message; rec.attempts = attempts || rec.attempts; logRec(rec); }
    return json(res, 502, { error: { message: `proxy: upstream error ${result.error.code || result.error.message}` } });
  }
  const st = (result && result.status) || 502;
  let b = (result && result.body && result.body.length) ? result.body
    : Buffer.from(JSON.stringify({ error: { message: `proxy: upstream responded ${st}${attempts ? ` after ${attempts} attempts` : ''}` } }));
  if (provider && provider.apiType === 'anthropic') {
    try {
      const j = JSON.parse(b.toString('utf8'));
      if (j.error && typeof j.error.message === 'string') {
        b = Buffer.from(JSON.stringify({ error: { message: j.error.message, type: j.error.type || 'api_error', upstream: true } }));
      }
    } catch { /* 原样 */ }
  }
  if (rec) { // 记录错误信息 + 上游原始错误返回
    rec.status = st; rec.attempts = attempts || rec.attempts;
    rec.error = (result && result.body) ? `upstream responded ${st}` : `proxy: upstream responded ${st}${attempts ? ` after ${attempts} attempts` : ''}`;
    rec.res = rec.res === null ? b.toString('utf8') : rec.res;
    logRec(rec);
  }
  res.writeHead(st, { 'Content-Type': (result && result.headers && result.headers['content-type']) || 'application/json' });
  res.end(b);
}

/* ---------------- /v1/models ---------------- */

async function handleModels(res, pick) {
  const cfg = config.load();
  if (!cfg.providers.length) return json(res, 503, { error: { message: 'proxy: 无可用 provider' } });
  const want = pick || cfg.defaultProvider;
  const provider = want ? cfg.providers.find((p) => p.name === want) : cfg.providers[0];
  if (!provider) return json(res, 400, { error: { message: `provider "${want || pick}" 不存在` } });

  // 配置了 models 列表 → 返回(含权重)
  const ids = provider.models.map((m) => m.id);
  const data = ids.map((id, i) => ({ id, object: 'model', owned_by: provider.name, weight: provider.models[i].weight }));
  return json(res, 200, { object: 'list', data });
}

module.exports = { handleChat, handleModels, json, shortKey, states, startTime };
