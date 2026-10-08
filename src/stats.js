/**
 * stats.js — 用量统计 v2
 *
 * 维度:
 *  - keys: per-provider/model/key 累计(持久化,兼容旧格式)
 *  - trends: 按小时趋势桶(近 7 天,持久化) — 请求量/成功/失败/重试/耗时/字节
 *  - errorTypes: 错误分类(429/5xx/net/model/timeout/4xx)
 *  - events: 降级/错误事件日志(内存环形缓冲,最近 200 条)
 *  - latency: 平均耗时(累计 totalMs)
 */
'use strict';
const fs = require('fs');
const path = require('path');

const STATS_FILE = process.env.STATS_FILE || '/var/lib/easy-llm-proxy/stats.json';
const SAVE_INTERVAL_MS = 60 * 1000;
const TREND_KEEP_HOURS = 168; // 保留 7 天
const EVENT_KEEP = 200;       // 事件环形缓冲上限

function shortKey(key) {
  if (typeof key !== 'string' || key.length <= 12) return key || '(empty)';
  return key.slice(0, 8) + '…' + key.slice(-4);
}

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
    // 新格式 { keys, trends };旧格式(顶层即 key 条目)自动包装
    const keys = raw && !raw.keys ? raw : (raw && raw.keys || {});
    // 迁移历史条目(v1/v2 早期无 model/totalMs),保证新聚合字段不缺
    for (const v of Object.values(keys)) {
      if (!v.model) v.model = '(legacy)';
      if (!v.totalMs) { v.totalMs = v.totalMs || 0; v.errorTypes = v.errorTypes || {}; }
    }
    return { keys, trends: raw && raw.trends || {} };
  } catch { return { keys: {}, trends: {} }; }
}

let STATE = load();
let EVENTS = []; // 内存环形

/** 清空全部统计(管理 API 重置按钮) */
function reset() {
  STATE = { keys: {}, trends: {}, errorTypes: {}, events: [], since: Date.now() };
  EVENTS = [];
  save();
}
let lastHour = hourKey(Date.now());

function hourKey(ts) { return new Date(ts).toISOString().slice(0, 13); } // "2024-10-07T21" (UTC)

// 统计行 id 用完整 key(避免短 key 截断碰撞);展示层仍用短 key
function idOf(provider, model, key) { return provider + '|' + model + '|' + key; }

function keyEntry(provider, model, key) {
  const id = idOf(provider, model, key);
  return STATE.keys[id] ??= {
    provider, model, key: shortKey(key),
    requests: 0, ok: 0, errors: 0, retries: 0,
    inputBytes: 0, outputBytes: 0, totalMs: 0,
    promptTokens: 0, cachedTokens: 0, completionTokens: 0,
    errorTypes: {}, lastSeen: 0,
  };
}

/** 滚动小时桶: 当前小时变化时清理过期桶并记录 */
function ensureHour(provider) {
  const hk = hourKey(Date.now());
  if (hk !== lastHour) {
    lastHour = hk;
    const cutKey = hourKey(Date.now() - TREND_KEEP_HOURS * 3600 * 1000);
    for (const k of Object.keys(STATE.trends)) {
      if (k < cutKey) delete STATE.trends[k];
    }
  }
  return hk;
}

/** 趋势桶: trends[小时][provider] = {计数} */
function trendEntry(hk, provider) {
  const bucket = STATE.trends[hk] ??= {};
  return bucket[provider] ??= {};
}

/** 计数(兼容旧调用: provider, model, key, field, n) — 同步更新 key 累计 + 小时趋势 */
function bump(provider, model, key, field, n = 1) {
  const e = keyEntry(provider, model, key);
  e[field] = (e[field] || 0) + n;
  e.lastSeen = Date.now();

  const hk = ensureHour(provider);
  const t = trendEntry(hk, provider);
  t.requests = (t.requests || 0) + (field === 'requests' ? n : 0);
  t.ok = (t.ok || 0) + (field === 'ok' ? n : 0);
  t.errors = (t.errors || 0) + (field === 'errors' ? n : 0);
  t.retries = (t.retries || 0) + (field === 'retries' ? n : 0);
  t.inputBytes = (t.inputBytes || 0) + (field === 'inputBytes' ? n : 0);
  t.outputBytes = (t.outputBytes || 0) + (field === 'outputBytes' ? n : 0);
  return e;
}

/** 记录一次上游尝试耗时(ms) */
function markLatency(provider, model, key, ms) {
  const e = keyEntry(provider, model, key);
  e.totalMs += ms;
  const t = trendEntry(ensureHour(provider), provider);
  t.ms = (t.ms || 0) + ms;
}

/** 记录真实 token(来自上游响应 usage): 请求/缓存命中/输出 */
function markTokens(provider, model, key, u) {
  if (!u) return;
  const e = keyEntry(provider, model, key);
  e.promptTokens += u.prompt || 0;
  e.cachedTokens += u.cached || 0;
  e.completionTokens += u.completion || 0;
  const t = trendEntry(ensureHour(provider), provider);
  t.promptTokens = (t.promptTokens || 0) + (u.prompt || 0);
  t.cachedTokens = (t.cachedTokens || 0) + (u.cached || 0);
  t.completionTokens = (t.completionTokens || 0) + (u.completion || 0);
}

/** 记录错误分类(type: 429|5xx|net|model|timeout|4xx) */
function markError(provider, model, key, type) {
  const e = keyEntry(provider, model, key);
  e.errorTypes[type] = (e.errorTypes[type] || 0) + 1;
  e.lastSeen = Date.now();
}

/** 事件日志(内存环形缓冲): {time, type, provider, model, key, detail} */
function recordEvent(ev) {
  EVENTS.push({ time: Date.now(), ...ev });
  if (EVENTS.length > EVENT_KEEP) EVENTS.splice(0, EVENTS.length - EVENT_KEEP);
}

const KEY_TTL_MS = 90 * 24 * 3600 * 1000; // 90 天不活跃清理(防 stats.json 无限增长)

function save() {
  try {
    fs.mkdirSync(path.dirname(STATS_FILE), { recursive: true });
    const cutoff = Date.now() - KEY_TTL_MS;
    for (const [id, v] of Object.entries(STATE.keys)) {
      if (v.lastSeen && v.lastSeen < cutoff) delete STATE.keys[id];
    }
    fs.writeFileSync(STATS_FILE, JSON.stringify({ keys: STATE.keys, trends: STATE.trends }));
  } catch { /* 统计失败不阻塞 */ }
}

/* ---------- 查询快照 ---------- */

function errSum(o) { return Object.values(o.errorTypes || {}).reduce((a, b) => a + b, 0); }

function snapshot() {
  return Object.values(STATE.keys)
    .map((s) => ({ ...s, failed: (s.errors || 0) + errSum(s), avgMs: s.requests ? Math.round(s.totalMs / s.requests) : 0, inputTokensEst: Math.round(s.inputBytes / 4), outputTokensEst: Math.round(s.outputBytes / 4), promptTokens: s.promptTokens || 0, cachedTokens: s.cachedTokens || 0, completionTokens: s.completionTokens || 0 }))
    .sort((a, b) => b.requests - a.requests);
}

/** 汇总(全维度) */
function summary() {
  const keys = Object.values(STATE.keys);
  const agg = keys.reduce((a, s) => {
    a.requests += s.requests || 0; a.ok += s.ok || 0; a.errors += s.errors || 0; a.retries += s.retries || 0;
    a.inputBytes += s.inputBytes || 0; a.outputBytes += s.outputBytes || 0; a.totalMs += s.totalMs || 0;
    a.promptTokens += s.promptTokens || 0; a.cachedTokens += s.cachedTokens || 0; a.completionTokens += s.completionTokens || 0;
    a.failed += (s.errors || 0) + errSum(s);
    for (const [t, n] of Object.entries(s.errorTypes || {})) a.errorTypes[t] = (a.errorTypes[t] || 0) + n;
    return a;
  }, { requests: 0, ok: 0, errors: 0, retries: 0, inputBytes: 0, outputBytes: 0, totalMs: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0, errorTypes: {}, failed: 0 });

  // 按 provider 汇总
  const byProvider = new Map();
  for (const s of keys) {
    let p = byProvider.get(s.provider);
    if (!p) { p = { name: s.provider, requests: 0, ok: 0, errors: 0, failed: 0, retries: 0, inputBytes: 0, outputBytes: 0, totalMs: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0, models: new Map() }; byProvider.set(s.provider, p); }
    p.requests += s.requests || 0; p.ok += s.ok || 0; p.errors += s.errors || 0; p.retries += s.retries || 0;
    p.inputBytes += s.inputBytes || 0; p.outputBytes += s.outputBytes || 0; p.totalMs += s.totalMs || 0;
    p.promptTokens += s.promptTokens || 0; p.cachedTokens += s.cachedTokens || 0; p.completionTokens += s.completionTokens || 0;
    p.failed += (s.errors || 0) + errSum(s);
    let m = p.models.get(s.model);
    if (!m) { m = { id: s.model, requests: 0, ok: 0, errors: 0, failed: 0, retries: 0, totalMs: 0, inputBytes: 0, outputBytes: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0 }; p.models.set(s.model, m); }
    m.requests += s.requests; m.ok += s.ok; m.errors += s.errors; m.retries += s.retries || 0;
    m.failed += (s.errors || 0) + errSum(s);
    m.totalMs += s.totalMs || 0; m.inputBytes += s.inputBytes || 0; m.outputBytes += s.outputBytes || 0;
    m.promptTokens += s.promptTokens || 0; m.cachedTokens += s.cachedTokens || 0; m.completionTokens += s.completionTokens || 0;
  }
  const providers = [...byProvider.values()].map((p) => ({
    ...p,
    models: [...p.models.values()].map((m) => ({ ...m, avgMs: m.requests ? Math.round(m.totalMs / m.requests) : 0 })),
    avgMs: p.requests ? Math.round(p.totalMs / p.requests) : 0,
  }));

  // 小时趋势(按时间升序)
  const hours = Object.entries(STATE.trends).sort(([a], [b]) => a.localeCompare(b)).map(([hk, provs]) => {
    let requests = 0, ok = 0, errors = 0, retries = 0, ms = 0;
    for (const p of Object.values(provs)) {
      requests += p.requests || 0; ok += p.ok || 0; errors += p.errors || 0; retries += p.retries || 0; ms += p.ms || 0;
    }
    return {
      hour: hk, requests, ok, errors, retries, ms,
      successRate: requests ? Math.round((ok / requests) * 1000) / 10 : null,
      avgMs: requests ? Math.round(ms / requests) : 0,
    };
  });

  // 日趋势(近 7 天)
  const days = new Map();
  for (const h of hours) {
    const d = h.hour.slice(0, 10);
    let dd = days.get(d);
    if (!dd) { dd = { date: d, requests: 0, ok: 0, errors: 0, ms: 0 }; days.set(d, dd); }
    dd.requests += h.requests; dd.ok += h.ok; dd.errors += h.errors; dd.ms += h.ms; // h.ms 已是该小时总耗时
  }
  const dayList = [...days.values()].sort((a, b) => a.date.localeCompare(b.date)).map((d) => ({ ...d, successRate: d.requests ? Math.round((d.ok / d.requests) * 1000) / 10 : null, avgMs: d.requests ? Math.round(d.ms / d.requests) : 0 }));

  return {
    summary: {
      requests: agg.requests, ok: agg.ok, errors: agg.errors, failed: agg.failed, retries: agg.retries,
      inputBytes: agg.inputBytes, outputBytes: agg.outputBytes,
      successRate: agg.requests ? Math.round((agg.ok / agg.requests) * 1000) / 10 : null,
      avgMs: agg.requests ? Math.round(agg.totalMs / agg.requests) : 0,
      errorTypes: agg.errorTypes,
      degrades: EVENTS.filter((e) => e.type === 'degrade').length,
      promptTokens: agg.promptTokens, cachedTokens: agg.cachedTokens, completionTokens: agg.completionTokens,
    },
    byProvider: providers,
    byKey: snapshot(),
    trends: { hours, days: dayList },
    recentEvents: [...EVENTS].reverse().slice(0, 50),
  };
}

setInterval(save, SAVE_INTERVAL_MS);
process.on('SIGTERM', () => { save(); process.exit(0); });
process.on('SIGINT', () => { save(); process.exit(0); });

module.exports = { bump, markLatency, markError, markTokens, recordEvent, save, snapshot, summary,
  reset
};