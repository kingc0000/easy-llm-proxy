/**
 * server.js — HTTP 服务器: 路由分发(/api/* → api.js, /v1/* → proxy.js, 静态 Web) + 健康检查
 * 启动入口: bin/start.js 调用 start()。
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const stats = require('./stats');
const requests = require('./requests');
const keys = require('./keys');
const PKG = require('../package.json');
const { handleChat, handleModels, json, startTime } = require('./proxy');
const { handleApi, adminOk, maskStatsKeys } = require('./api');

const MAX_BODY = 32 * 1024 * 1024; // 请求体上限 32MB(防内存滥用) — server.js 的 /v1 路由也要用
const PORT = parseInt(process.env.PROXY_PORT || '8787', 10);
const BIND_HOST = process.env.BIND_HOST || '127.0.0.1'; // 本地默认仅回环;Docker 设 0.0.0.0
const WEB_DIR = path.join(__dirname, '..', 'web');

/* ---------------- 外部接入 key(baseURL + key) ----------------
 * /v1/* 需携带 Authorization: Bearer <key> 或 x-api-key: <key>。
 * 只要 keys.json 里存在任意有效 key 就强制校验(fail closed);
 * 一个都没建 = 开放模式(旧的仅内网自用行为),启动会打警告。
 */
function extractKey(req) {
  const h = req.headers;
  const b = h['authorization'];
  if (typeof b === 'string' && /^bearer\s+\S/i.test(b)) return b.replace(/^bearer\s+/i, '').trim();
  const x = h['x-api-key'];
  if (typeof x === 'string' && x.trim()) return x.trim();
  return '';
}

/** /v1 调用一律入日志(成功/拒绝/超限/列模型): provider/ingressKey 记名称,便于按外部客户端审计 */
function logV1Call(pathname, req, status, opts = {}) {
  requests.log({
    t: Date.now(),
    path: pathname,
    method: req.method,
    status,
    provider: opts.provider || null,
    model: opts.model ?? null,
    usedModel: opts.model ?? null,
    key: null,
    ms: 0,
    attempts: 0,
    degraded: false,
    error: opts.error || null,
    ingressKey: (req.ingressKey && req.ingressKey.name) || (opts.maskedIngress || null),
    ingressKeyId: (req.ingressKey && req.ingressKey.id) || null,
    req: null,
    res: null,
    promptTokens: 0,
    cachedTokens: 0,
    completionTokens: 0,
  });
}

/* ---------------- 静态 Web ---------------- */

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
/** 静态资源路径解析: 返回 WEB_DIR 内的绝对路径,逃逸返回 null(抽为纯函数便于测试)
 *  校验必须带 path.sep 分隔符: 否则 WEB_DIR 前缀同名的兄弟目录(如 web2/)也会通过 startsWith 放行 */
function resolveStatic(pathname) {
  // 修复: 空 pathname(如 url="?x") 应视为首页;此前落入 rel='' 分支 → path.join(WEB_DIR,'')=WEB_DIR
  // 不以 WEB_DIR+sep 开头 → 返回 null → 403(而非首页)
  const rel = (pathname === '/' || pathname === '') ? 'index.html' : String(pathname || '').replace(/^\/+/, '');
  const file = path.join(WEB_DIR, rel);
  return file.startsWith(WEB_DIR + path.sep) ? file : null;
}
function serveStatic(res, pathname) {
  const file = resolveStatic(pathname);
  if (!file) return json(res, 403, { error: { message: 'forbidden' } });
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
    if (pathname.startsWith('/v1/')) {
      // 外部接入鉴权:baseURL + key。放在 try 之前拦截,失败不产生任何上游流量
      if (keys.isEnforced()) {
        const presented = extractKey(req);
        const rec = keys.verify(presented);
        if (!rec) {
          const code = presented ? 'invalid_api_key' : 'missing_api_key';
          const msg = presented ? 'invalid api key' : 'missing api key';
          // 被拒调用也入日志:ingressKey 只存脱敏前缀(真实 key 绝不落盘)
          logV1Call(pathname, req, 401, { error: `${msg} [${code}]`, maskedIngress: presented ? presented.slice(0, 12) + '…' : null });
          return json(res, 401, { error: { message: msg, type: 'authentication_error', code } });
        }
        req.ingressKey = rec; // 记录入口 key(供调用日志区分外部客户端)
      }
    }
    if (pathname === '/health' || pathname === '/healthz') {
      const cfg = config.load();
      const ks = keys.summary();
      return json(res, 200, {
        status: 'ok', version: PKG.version, uptime: Math.floor((Date.now() - startTime) / 1000),
        providers: cfg.providers.length,
        totalModels: cfg.providers.reduce((n, p) => n + p.models.length, 0),
        totalKeys: cfg.providers.reduce((n, p) => n + (Array.isArray(p.keys) && p.keys.length ? p.keys.length : new Set(p.models.flatMap((m) => m.keys)).size), 0),
        ingress: { enforced: ks.enforced, active: ks.active, revoked: ks.revoked, totalReqs: ks.totalReqs, totalTokens: ks.totalTokens },
        ingressMode: ks.enforced ? 'key-required' : 'open',
        providers_detail: cfg.providers.map((p) => ({ name: p.name, apiType: p.apiType, models: p.models.map((m) => ({ id: m.id, weight: m.weight, keys: m.keys.length })) })),
      });
    }
    if (pathname === '/stats') {
      if (!adminOk(req)) return json(res, 401, { error: { message: 'admin token required' } }); // 与 /api/stats 同门禁
      return json(res, 200, {
        status: 'ok', since: new Date(startTime).toISOString(), uptime: Math.floor((Date.now() - startTime) / 1000),
        ...maskStatsKeys(stats.summary(), config.load().providers),
      });
    }
    if (pathname === '/v1/models') { logV1Call(pathname, req, 200, { provider: pick }); return handleModels(res, pick); }
    if (pathname === '/v1/chat/completions' || pathname === '/v1/completions' || pathname === '/v1/messages') {
      const chunks = [];
      let size = 0;
      let tooBig = false;
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) {
          tooBig = true;
          if (!res.headersSent) { logV1Call(pathname, req, 413, { error: `request body too large (${MAX_BODY / 1024 / 1024}MB)` }); json(res, 413, { error: { message: 'request body too large' } }); } // 立即响应(端回调可能不触发)
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        if (tooBig) return;
        const body = chunks.length ? Buffer.concat(chunks) : null;
        handleChat(req, res, pathname, req.method, body, pick)
          .catch((e) => { console.error('[proxy] handleChat error:', e.stack || e.message); if (!res.headersSent) { logV1Call(pathname, req, 500, { error: 'proxy internal: ' + e.message }); json(res, 500, { error: { message: 'proxy internal: ' + e.message } }); } });
      });
      req.on('error', () => { if (!res.headersSent) { logV1Call(pathname, req, 400, { error: 'bad request (连接异常中断)' }); json(res, 400, { error: { message: 'bad request' } }); } });
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
  requests.cleanup(); // 启动清理过期调用日志
  // ⚠ 故意不在启动时自动补建元数据索引:大日志文件(数百 MB)扫描若在 listen 之前跑,
  //   一旦内存/耗时失控就是崩溃-重启死循环(2026-10-14 事故:487MB 日志 + backfill
  //   导致 132 次重启、服务 33 分钟不可用)。旧日志缺 meta 时列表自动降级为流式扫描;
  //   需要重建索引请离线执行: node bin/index-logs.js
  if (process.env.REQUESTS_BACKFILL === '1') {
    const indexed = requests.backfill();
    if (indexed) console.log(`[easy-llm-proxy] 调用日志索引: 为旧日志补建 ${indexed} 条元数据(REQUESTS_BACKFILL=1)`);
  }
  setInterval(() => requests.cleanup(), 24 * 3600 * 1000).unref();
  server.listen(PORT, BIND_HOST, () => {
    const cfg = config.load();
    console.log(`[easy-llm-proxy] http://${BIND_HOST === '0.0.0.0' ? '127.0.0.1' : BIND_HOST}:${PORT} | providers: ${cfg.providers.length} | models: ${cfg.providers.reduce((n, p) => n + p.models.length, 0)} | keys: ${cfg.providers.reduce((n, p) => n + p.models.reduce((x, m) => x + m.keys.length, 0), 0)}`);
    console.log(`[easy-llm-proxy] Web 管理: http://127.0.0.1:${PORT}/ | 配置: ${config.CONFIG_FILE}`);
    const ks = keys.summary();
    if (ks.enforced) {
      console.log(`[easy-llm-proxy] 外部接入: key 校验已开启(有效 ${ks.active} 个 / 累计请求 ${ks.totalReqs}) | baseURL https://<域名>/v1 | key 存储 ${ks.storeFile}`);
    } else {
      console.warn(`[easy-llm-proxy] ⚠ /v1 开放模式(未创建任何接入 key,任何可达 /v1 的请求都会被转发)。公网部署请先在面板「外部接入」或 POST /api/keys 创建 key;创建后强制状态会持久化,吊销全部 key 也不会退回开放`);
    }
  });
  return server;
}

// 全局兜底: 任何未捕获的异步错误不导致进程崩溃(记日志)
process.on('unhandledRejection', (e) => console.error('[proxy] unhandledRejection:', e && (e.stack || e.message)));
process.on('uncaughtException', (e) => { console.error('[proxy] uncaughtException:', e && (e.stack || e.message)); });

module.exports = { start, server, handleChat, resolveStatic, WEB_DIR };
