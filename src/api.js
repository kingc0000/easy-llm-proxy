/**
 * api.js — 管理 API(/api/*): 登录/账号、健康、统计、调用日志、配置 CRUD、Provider 增删改与连接测试
 *
 * 鉴权: 登录会话(auth.check)优先;env ADMIN_TOKEN 作备用钥匙。
 * 从 proxy.js 复用: json/shortKey/states/startTime(避免与 server.js 循环依赖)。
 */
'use strict';
const auth = require('./auth');
const config = require('./config');
const stats = require('./stats');
const requests = require('./requests');
const ad = require('./adapters');
const { json, shortKey, states, startTime } = require('./proxy');

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

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
    const sum = stats.summary();
    // 统计响应把 key 替换为 key1/key2/key3 序号(真实 key 不出接口)
    const idxMap = new Map();
    const shortOf = (k) => (k && k.length > 12 ? k.slice(0, 8) + '…' + k.slice(-4) : k);
    for (const p of config.load().providers) {
      (p.keys || []).forEach((k, i) => { idxMap.set(k, 'key' + (i + 1)); idxMap.set(shortOf(k), 'key' + (i + 1)); });
      for (const m of p.models) (m.keys || []).forEach((k) => { const n = 'key' + (idxMap.size / 2 + 1); if (!idxMap.has(k)) { idxMap.set(k, n); idxMap.set(shortOf(k), n); } });
    }
    if (idxMap.size) sum.byKey = sum.byKey.map((s) => ({ ...s, key: idxMap.get(s.key) || 'key?' }));
    return json(res, 200, {
      status: 'ok', since: new Date(startTime).toISOString(), uptime: Math.floor((Date.now() - startTime) / 1000),
      ...sum,
    });
  }
  if (pathname === '/api/stats/reset' && method === 'POST') {
    stats.reset();
    return json(res, 200, { ok: true });
  }
  if (pathname === '/api/requests/dates' && method === 'GET') {
    return json(res, 200, { dates: requests.dates() });
  }
  if (pathname === '/api/requests' && method === 'GET') {
    const q = new URL(req.url, 'http://x').searchParams;
    return requests.list(q.get('date') || '', {
      model: q.get('model') || '', status: q.get('status') || '', q: q.get('q') || '',
      offset: q.get('offset') || '0', limit: q.get('limit') || '50',
    }).then((data) => json(res, 200, data)).catch(() => json(res, 500, { ok: false, error: 'read failed' }));
  }
  if (isConf && method === 'GET') {
    const cfg = config.load();
    // 响应层剥离 model.keys:key 属 provider 级,models 共享(内部 balance 仍需,仅接口隐藏)
    const out = { ...cfg, providers: cfg.providers.map((p) => ({ ...p, keys: (p.keys || []).map((k) => ({ value: k, note: (p.keyNotes || {})[k] || '' })), models: p.models.map((m) => ({ ...m, keys: undefined })) })) };
    return json(res, 200, out);
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

module.exports = { handleApi, adminOk };
