/**
 * proxy.js — easy-llm-proxy 主服务
 *  - /v1/chat/completions, /v1/models: 代理(接加权轮询引擎),OpenAI 兼容
 *  - /health, /stats: 健康与用量
 *  - /api/*: provider 管理 API(Web 面板用)
 *  - /: Web 管理页面(静态)
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const balance = require('./balance');
const stats = require('./stats');
const ad = require('./adapters');
const auth = require('./auth');

const PORT = parseInt(process.env.PROXY_PORT || '8787', 10);
const BIND_HOST = process.env.BIND_HOST || '127.0.0.1'; // 本地默认仅回环;Docker 设 0.0.0.0
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const WEB_DIR = path.join(__dirname, '..', 'web');
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
  let planList = confModel
    ? balance.plan(provider, st, requestedModel)
    : balance.plan(provider, st, null).filter((c) => c.modelId === mainId); // 只用主 model 的 key 池
  const cap = balance.maxAttempts(provider);
  let attempts = 0;
  let planIdx = 0;
  let degradeCount = 0;
  let lastResult = null;

  while (attempts < cap) {
    const c = planList[planIdx];
    if (!c) break;
    planIdx++;
    attempts++;

    // 构造本次尝试的上游请求(降级切换改写 model + anthropic body 转换)
    const { upPath, upPayload } = prepUpstream(provider, pathname, body, c, requestedModel, passThrough);

    balance.advanceKey(st, c.modelId); // 预留游标(并发请求公平分摊 key)
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
          if (Object.keys(add).length) stats.markTokens(provider.name, c.modelId, c.key, add);
        });
      } else if (result.body) {
        ok.outputBytes += result.body.length;
        const u = ad.usageOf(result.body, provider.apiType);
        if (u) stats.markTokens(provider.name, c.modelId, c.key, u);
      }
      balance.report(provider, st, c.modelId, true);
      return outputOk(res, provider, result, parsed && parsed.stream, parsed && parsed.model);
    }
    if (d.kind === 'final') {
      stats.bump(provider.name, c.modelId, c.key, 'errors');
      return outputFail(res, provider, result, 0);
    }
    stats.bump(provider.name, c.modelId, c.key, 'retries');
    console.log(`[proxy] ${method} ${pathname} -> ${result.status || 'ERR'} | ${provider.name}/${c.modelId} key ${shortKey(c.key)} (${d.reason}) 尝试 ${attempts}/${cap}`);

    // retry: 该 model 的 key 已耗尽 → 降级重排(passThrough 模式不跨 model 降级,直接耗尽)
    const remainingOfModel = planList.slice(planIdx).filter((x) => x.modelId === c.modelId).length;
    if (remainingOfModel === 0) {
      if (passThrough) break; // 未配置的 model 只换 key,不降级(保持 v1 行为)
      balance.degrade(provider, st, c.modelId);
      stats.recordEvent({ type: 'degrade', provider: provider.name, model: c.modelId, toModel: st.degraded ? st.degraded.modelId : null, reason: d.reason });
      degradeCount++;
      planList = balance.plan(provider, st, requestedModel);
      planIdx = 0;
      if (degradeCount > provider.models.length + 2) break; // 兜底防无限降级
    }
  }

  // 耗尽
  return outputFail(res, provider, lastResult, attempts);
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

function outputOk(res, provider, result, isStream, model) {
  if (result.error) return json(res, 502, { error: { message: `proxy: upstream error ${result.error.code || result.error.message}` } });
  if (provider.apiType === 'anthropic') {
    const headers = ad.filterHeaders(result.headers);
    if (isStream) {
      headers['content-type'] = 'text/event-stream';
      res.writeHead(result.status, headers);
      const conv = ad.anthropicSseToOpenAI(model || 'unknown');
      result.stream.on('error', (e) => { console.error('[proxy] upstream stream error:', e.message); res.destroy(); });
      res.on('close', () => result.stream.destroy());
      res.on('error', () => result.stream.destroy());
      return result.stream.pipe(conv).pipe(res);
    }
    return (async () => {
      const raw = await ad.consumeSmall(result.stream, 32 * 1024 * 1024); // 32MB 上限,避免大响应截断损坏
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
  res.on('close', () => result.stream.destroy());
  res.on('error', () => result.stream.destroy());
  return result.stream.pipe(res);
}

function outputFail(res, provider, result, attempts) {
  if (result && result.error) {
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

/* ---------------- 管理 API ---------------- */

/** 管理 API 鉴权: 登录会话(auth.check)优先;env ADMIN_TOKEN 作备用钥匙。
 *  注意: 不做回环豁免 — nginx 反代后 remoteAddress 恒为 127.0.0.1,回环判断等于公网裸奔。 */
function adminOk(req) {
  const t = req.headers['x-admin-token'] || '';
  if (ADMIN_TOKEN && t === ADMIN_TOKEN) return true;   // 备用钥匙(运维/脚本)
  if (auth.check(t)) return true;                      // 面板登录会话
  return false;
}

const MAX_BODY = 32 * 1024 * 1024; // 请求体上限 32MB(防内存滥用)

/** 读取请求体;超限立即响应 413(客户端能收到而非断连) */
function readBody(req, res) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        tooBig = true;
        if (!res.headersSent) json(res, 413, { error: { message: 'request body too large' } });
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(tooBig ? null : Buffer.concat(chunks)));
    req.on('error', () => { if (!res.headersSent) json(res, 400, { error: { message: 'bad request' } }); resolve(null); });
  });
}

/** 管理 API: provider 结构校验(防"缺字段静默自毁") */
function validateProviderPayload(p) {
  if (!p || typeof p.name !== 'string' || !p.name.trim()) return 'name 必填';
  if (!Array.isArray(p.models) || !p.models.length) return '至少一个 model';
  for (const m of p.models) {
    if (!m || typeof m.id !== 'string' || !m.id.trim()) return 'model 缺少 id';
    if (!Array.isArray(m.keys) || !m.keys.length || !m.keys.every((k) => typeof k === 'string' && k)) return `model "${m.id}" 缺少有效 keys`;
    if (Number.isFinite(m.weight) && (m.weight < 1 || m.weight > 100)) return `model "${m.id}" weight 需 1-100`;
  }
  return null;
}

async function handleApi(req, res, pathname, method) {
  // 登录(免鉴权;未初始化账号时提示管理员)
  if (pathname === '/api/login' && method === 'POST') {
    const body = await readBody(req, res);
    if (!body) return;
    let p = null;
    try { p = JSON.parse(body.toString('utf8')); } catch { p = null; }
    const r = auth.login(p && p.username, p && p.password);
    if (r.ok) return json(res, 200, { ok: true, token: r.token, username: r.username, weak: !!r.weak });
    if (r.reason === 'locked') return json(res, 429, { error: { message: `登录失败过多,请 ${r.retryAfter}s 后重试` } });
    if (r.reason === 'no_account') return json(res, 401, { error: { message: '账号未初始化: 管理员需先创建 auth.json(AUTH_USER/AUTH_PASS)' } });
    return json(res, 401, { error: { message: '用户名或密码错误' } });
  }
  if (!adminOk(req)) return json(res, 401, { error: { message: 'admin token required' } });
  // 修改用户名/密码(需当前会话 + 旧密码)
  if (pathname === '/api/account' && method === 'POST') {
    const body = await readBody(req, res);
    if (!body) return;
    let p = null;
    try { p = JSON.parse(body.toString('utf8')); } catch { p = null; }
    if (!p || typeof p.old_password !== 'string') return json(res, 400, { error: { message: '需要 old_password' } });
    const r = auth.update(p.old_password, p.new_username, p.new_password);
    if (r.ok) return json(res, 200, { ok: true, username: r.username });
    if (r.reason === 'old_password_wrong') return json(res, 401, { error: { message: '旧密码错误' } });
    if (r.reason === 'nothing_changed') return json(res, 400, { error: { message: '用户名与密码都未变化' } });
    return json(res, 401, { error: { message: '账号未初始化' } });
  }
  const body = await readBody(req, res);
  if (!body) return; // 超限已响应 413
  let payload = null;
  if (body.length) { try { payload = JSON.parse(body.toString('utf8')); } catch { return json(res, 400, { error: { message: 'invalid JSON' } }); } }

  const m = pathname.match(/^\/api\/providers(?:\/([^/]+))?(?:\/(test))?/);
  const isConf = pathname === '/api/config';

  if (pathname === '/api/health') {
    return json(res, 200, { status: 'ok', uptime: Math.floor((Date.now() - startTime) / 1000) });
  }
  if (pathname === '/api/stats') {
    return json(res, 200, {
      status: 'ok', since: new Date(startTime).toISOString(), uptime: Math.floor((Date.now() - startTime) / 1000),
      ...stats.summary(),
    });
  }
  if (isConf && method === 'GET') {
    const cfg = config.load();
    return json(res, 200, cfg);
  }
  if (isConf && (method === 'PUT' || method === 'POST')) {
    // 整体替换配置: 去重同 name provider(后覆盖前),避免同名共享状态
    if (!payload || !Array.isArray(payload.providers)) return json(res, 400, { error: { message: '需要 {providers:[...]}' } });
    const seen = new Set();
    const dedup = payload.providers.filter((p) => (p && p.name && !seen.has(p.name) && seen.add(p.name)));
    if (dedup.length !== payload.providers.length) {
      payload = { ...payload, providers: dedup };
      console.warn('[proxy] PUT /api/config 已去重同名 provider');
    }
    config.save(payload);
    states.clear();
    return json(res, 200, { ok: true });
  }
  if (m) {
    let name;
    try { name = m[1] ? decodeURIComponent(m[1]) : undefined; } catch { name = m[1]; }
    const action = m[2];
    const cfg = config.load();
    const idx = name ? cfg.providers.map((p) => p.name).indexOf(name) : -1;
    if (method === 'GET' && !name) {
      // 脱敏展示 keys
      const masked = cfg.providers.map((p) => ({
        ...p,
        models: p.models.map((md) => ({ ...md, keys: md.keys.map(shortKey) })),
      }));
      return json(res, 200, { defaultProvider: cfg.defaultProvider, providers: masked });
    }
    if (method === 'POST' && !name) {
      const err = validateProviderPayload(payload);
      if (err) return json(res, 400, { error: { message: err } });
      if (cfg.providers.some((p) => p.name === payload.name)) return json(res, 409, { error: { message: 'provider 已存在' } });
      cfg.providers.push(payload);
      config.save(cfg);
      states.delete(payload.name);
      return json(res, 200, { ok: true });
    }
    if (name && action === 'test' && (method === 'PUT' || method === 'POST')) {
      // 测试连接: 优先用 body 里的临时 provider(编辑页未保存测试),否则用已保存的
      const p = (payload && payload.provider) || (idx >= 0 ? cfg.providers[idx] : null);
      const perr = p && p.name && p.models && p.baseURL ? validateProviderPayload(p) : 'provider 配置不完整';
      if (perr) return json(res, 400, { error: { message: perr } });
      const first = p.models[0];
      const t0 = Date.now();
      const r = await ad.attempt(p, first.keys[0], ad.modelsPathOf(), 'GET', null);
      const ms = Date.now() - t0;
      if (r.error) return json(res, 200, { ok: false, status: 0, ms, error: r.error.message });
      const small = await ad.consumeSmall(r.stream, 4096);
      let sample = small.toString('utf8').slice(0, 120);
      return json(res, 200, { ok: r.status >= 200 && r.status < 300, status: r.status, ms, sample });
    }
    if (name && idx >= 0) {
      if (method === 'PUT' || method === 'POST') {
        if (payload && payload.name) {
          if (payload.name !== name) return json(res, 400, { error: { message: 'PUT 不允许改名(请先 DELETE 再 POST)' } });
          const err = validateProviderPayload(payload);
          if (err) return json(res, 400, { error: { message: err } });
          cfg.providers[idx] = payload;
          config.save(cfg);
          states.delete(name);
          return json(res, 200, { ok: true });
        }
      }
      if (method === 'DELETE') {
        cfg.providers.splice(idx, 1);
        config.save(cfg);
        states.delete(name);
        return json(res, 200, { ok: true });
      }
    }
  }
  return json(res, 404, { error: { message: 'not found' } });
}

/* ---------------- 静态 Web ---------------- */

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.join(WEB_DIR, rel);
  if (!file.startsWith(WEB_DIR)) return json(res, 403, { error: { message: 'forbidden' } });
  fs.readFile(file, (err, data) => {
    if (err) return json(res, 404, { error: { message: 'not found' } });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

/* ---------------- 服务 ---------------- */

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(403, { 'Content-Type': 'application/json' }); // 关闭任意源跨域预检
    return res.end(JSON.stringify({ error: { message: 'cross-origin not allowed' } }));
  }
  const pathname = req.url.split('?')[0];
  const pick = req.headers['x-provider-name'] || null;

  const run = async () => {
    if (pathname.startsWith('/api/')) return handleApi(req, res, pathname, req.method);
    if (pathname === '/health' || pathname === '/healthz') {
      const cfg = config.load();
      return json(res, 200, {
        status: 'ok', uptime: Math.floor((Date.now() - startTime) / 1000),
        providers: cfg.providers.length,
        totalModels: cfg.providers.reduce((n, p) => n + p.models.length, 0),
        totalKeys: cfg.providers.reduce((n, p) => n + p.models.reduce((x, m) => x + m.keys.length, 0), 0),
        providers_detail: cfg.providers.map((p) => ({ name: p.name, apiType: p.apiType, models: p.models.map((m) => ({ id: m.id, weight: m.weight, keys: m.keys.length })) })),
      });
    }
    if (pathname === '/stats') {
      if (!adminOk(req)) return json(res, 401, { error: { message: 'admin token required' } }); // 与 /api/stats 同门禁
      return json(res, 200, {
        status: 'ok', since: new Date(startTime).toISOString(), uptime: Math.floor((Date.now() - startTime) / 1000),
        ...stats.summary(),
      });
    }
    if (pathname === '/v1/models') return handleModels(res, pick);
    if (pathname === '/v1/chat/completions' || pathname === '/v1/completions' || pathname === '/v1/messages') {
      const chunks = [];
      let size = 0;
      let tooBig = false;
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) {
          tooBig = true;
          if (!res.headersSent) json(res, 413, { error: { message: 'request body too large' } }); // 立即响应(端回调可能不触发)
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        if (tooBig) return;
        const body = chunks.length ? Buffer.concat(chunks) : null;
        handleChat(req, res, pathname, req.method, body, pick)
          .catch((e) => { console.error('[proxy] handleChat error:', e.stack || e.message); if (!res.headersSent) json(res, 500, { error: { message: 'proxy internal: ' + e.message } }); });
      });
      req.on('error', () => { if (!res.headersSent) json(res, 400, { error: { message: 'bad request' } }); });
      return;
    }
    // 静态 Web
    return serveStatic(res, pathname);
  };
  run().catch((e) => {
    console.error(`[proxy] internal error: ${e.stack || e.message}`);
    if (!res.headersSent) json(res, 500, { error: { message: `proxy internal: ${e.message}` } });
    else res.end();
  });
});

function start() {
  server.listen(PORT, BIND_HOST, () => {
    const cfg = config.load();
    console.log(`[easy-llm-proxy] http://127.0.0.1:${PORT} | providers: ${cfg.providers.length} | models: ${cfg.providers.reduce((n, p) => n + p.models.length, 0)} | keys: ${cfg.providers.reduce((n, p) => n + p.models.reduce((x, m) => x + m.keys.length, 0), 0)}`);
    console.log(`[easy-llm-proxy] Web 管理: http://127.0.0.1:${PORT}/ | 配置: ${config.CONFIG_FILE}`);
  });
  return server;
}

// 全局兜底: 任何未捕获的异步错误不导致进程崩溃(记日志)
process.on('unhandledRejection', (e) => console.error('[proxy] unhandledRejection:', e && (e.stack || e.message)));
process.on('uncaughtException', (e) => { console.error('[proxy] uncaughtException:', e && (e.stack || e.message)); });

module.exports = { start, server, handleChat };