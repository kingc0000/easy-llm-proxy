/**
 * config.js — easy-llm-proxy v2 配置模型
 *
 * v2 配置格式:
 * {
 *   "defaultProvider": null,
 *   "providers": [
 *     {
 *       "name": "sensenova",
 *       "apiType": "openai",              // "openai" | "anthropic"
 *       "baseURL": "https://token.sensenova.cn",
 *       "apiPath": null,                  // 可选: 自定义 chat 路径
 *       "apiKeyHeader": null,             // 可选: 自定义认证头
 *       "extraHeaders": {},               // 可选: 附加静态头
 *       "usageLimit": 5,                  // provider 级默认: 降级后成功次数达到则切回主 model (0=不限)
 *       "useSeconds": 10,                 // provider 级默认: 降级后持续秒数达到则切回主 model (0=不限)
 *       "models": [                       // 每个 model 可配多 key + 权重
 *         { "id": "deepseek-v4-flash", "weight": 100, "usageLimit": null, "useSeconds": null, "keys": ["sk-.."] },
 *         { "id": "sensenova-6.8-flash-lite", "weight": 99, "usageLimit": null, "useSeconds": null, "keys": ["sk-.."] }
 *       ]
 *     }
 *   ]
 * }
 *
 * 兼容:
 *  - v1 旧格式(provider.keys 数组) → 自动转换为单 model { id: "default", weight: 100, keys }
 *  - sensenova-proxy 旧配置(/etc/sensenova-proxy/config.json) → 同上
 */
'use strict';
const fs = require('fs');
const path = require('path');

const CONFIG_FILE = process.env.CONFIG_FILE || '/etc/easy-llm-proxy/config.json';
const LEGACY_CONFIG_FILE = '/etc/sensenova-proxy/config.json';
const LEGACY_KEYS_FILE = process.env.KEYS_FILE || '/etc/sensenova-proxy/keys.json';
const DEFAULT_UPSTREAM = process.env.UPSTREAM_BASE || 'https://token.sensenova.cn';

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function normalizeProvider(p, i) {
  // provider 级降级默认(0 = 不限次数/不限时长)
  const defUsageLimit = Number.isInteger(p.usageLimit) && p.usageLimit >= 0 ? p.usageLimit : 5;
  const defUseSeconds = Number.isInteger(p.useSeconds) && p.useSeconds >= 0 ? p.useSeconds : 10;
  // model 级显式值优先(0 = 不限),未配则回退 provider 级默认
  const pickLimit = (m) => (Number.isInteger(m.usageLimit) && m.usageLimit >= 0 ? m.usageLimit : defUsageLimit);
  const pickSeconds = (m) => (Number.isInteger(m.useSeconds) && m.useSeconds >= 0 ? m.useSeconds : defUseSeconds);

  // key 属于 provider 级(共享池);model 也可单独覆盖 keys(兼容)
  const providerKeys = Array.isArray(p.keys) ? p.keys.filter((k) => typeof k === 'string' && k.length) : [];
  const models = [];
  if (Array.isArray(p.models) && p.models.length) {
    for (const m of p.models) {
      if (!m || !m.id) continue;
      const ownKeys = Array.isArray(m.keys) ? m.keys.filter((k) => typeof k === 'string' && k.length) : [];
      const keys = ownKeys.length ? ownKeys : providerKeys; // model 无 key → 共享 provider 池
      if (!keys.length) continue;
      models.push({
        id: String(m.id),
        weight: clampWeight(m.weight),
        usageLimit: pickLimit(m),
        useSeconds: pickSeconds(m),
        keys,
      });
    }
  }
  if (!models.length && providerKeys.length) {
    models.push({ id: 'default', weight: 100, usageLimit: defUsageLimit, useSeconds: defUseSeconds, keys: providerKeys });
  }
  if (!models.length) return null;

  return {
    name: String(p.name || 'provider-' + (i + 1)),
    apiType: String(p.apiType || 'openai').toLowerCase(),
    baseURL: String(p.baseURL || DEFAULT_UPSTREAM).replace(/\/+$/, ''),
    apiPath: p.apiPath ? String(p.apiPath) : null,
    apiKeyHeader: p.apiKeyHeader ? String(p.apiKeyHeader) : null,
    extraHeaders: (p.extraHeaders && typeof p.extraHeaders === 'object') ? p.extraHeaders : {},
    usageLimit: defUsageLimit,
    useSeconds: defUseSeconds,
    keys: providerKeys,
    models,
  };
}

function clampWeight(w) {
  if (!Number.isFinite(w)) return 100;
  return Math.min(100, Math.max(1, Math.round(w)));
}

/** 读取配置并归一化（mtime 缓存: 文件变化才重读,保留热加载且不阻塞高并发） */
let _cache = { mtime: 0, data: null };
function load() {
  let mtime = 0;
  try { mtime = fs.statSync(CONFIG_FILE).mtimeMs; } catch {}
  if (mtime === _cache.mtime) return _cache.data || { defaultProvider: null, providers: [] };
  const cfg = readJson(CONFIG_FILE) || readJson(LEGACY_CONFIG_FILE) || readJson(LEGACY_KEYS_FILE);
  if (!cfg) return { defaultProvider: null, providers: [] };

  let defaultProvider = null;
  let raw;
  if (Array.isArray(cfg)) {
    raw = cfg.every((x) => typeof x === 'string')
      ? [{ baseURL: DEFAULT_UPSTREAM, keys: cfg }]
      : cfg;
  } else if (Array.isArray(cfg.providers)) {
    defaultProvider = cfg.defaultProvider || null;
    raw = cfg.providers;
  } else if (Array.isArray(cfg.keys)) {
    raw = [{ baseURL: cfg.baseURL || DEFAULT_UPSTREAM, keys: cfg.keys }];
  } else {
    return { defaultProvider: null, providers: [] };
  }

  let providers = raw.map(normalizeProvider).filter(Boolean);
  // 去重同名 provider(保留首个): 避免 states 按 name 共享导致串扰
  const seenP = new Set();
  providers = providers.filter((p) => (!seenP.has(p.name) && seenP.add(p.name)));
  // 去重同 id model(保留首个): 避免引擎按 id 去重时第二个静默失效
  for (const p of providers) {
    const seenM = new Set();
    p.models = p.models.filter((m) => (!seenM.has(m.id) && seenM.add(m.id)));
  }
  const out = { defaultProvider, providers };
  _cache = { mtime, data: out };
  return out;
}

/** 保存配置（原子写,Web 管理面板用） */
function save(cfg) {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  const tmp = CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 }); // 含真实 key,仅属主可读
  fs.renameSync(tmp, CONFIG_FILE);
  _cache = { mtime: fs.statSync(CONFIG_FILE).mtimeMs, data: null }; // 失效缓存下次重读
}

module.exports = { load, save, CONFIG_FILE };