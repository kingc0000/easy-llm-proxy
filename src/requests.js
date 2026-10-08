/**
 * requests.js — 调用日志(原始请求/原始返回/错误信息)
 *
 *  - 按天落盘 REQUESTS_DIR/<YYYY-MM-DD>.jsonl(每行一条 JSON,append-only)
 *  - 原始返回含流式 SSE 原文(截断上限 REQUESTS_MAX_REC,默认 512KB)
 *  - 自动清理 REQUESTS_KEEP_DAYS(默认 7)天前的文件
 *  - 文件权限 600(可能含敏感对话内容)
 */
'use strict';
const fs = require('fs');
const path = require('path');

const DIR = process.env.REQUESTS_DIR || '/var/lib/easy-llm-proxy/requests';
const KEEP_DAYS = parseInt(process.env.REQUESTS_KEEP_DAYS || '7', 10);
const MAX_REC = parseInt(process.env.REQUESTS_MAX_REC || (512 * 1024).toString(), 10); // 响应原文截断字节
const MAX_REQ = parseInt(process.env.REQUESTS_MAX_REQ || (1024 * 1024).toString(), 10); // 请求体截断字节

function dayKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

/** 追加一条日志(异步写盘,不阻塞请求) */
function log(rec) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const { logged, resChunks, ...rest } = rec; // 剔除内部字段
    const line = JSON.stringify(rest) + '\n';
    fs.appendFile(path.join(DIR, dayKey(new Date(rec.t || Date.now())) + '.jsonl'), line, { mode: 0o600 }, () => {});
  } catch { /* 日志失败不阻塞主流程 */ }
}

/** 清理过期日志文件(启动时与每日调用) */
function cleanup() {
  try {
    const cutoff = Date.now() - KEEP_DAYS * 86400 * 1000;
    for (const f of fs.readdirSync(DIR)) {
      if (!f.endsWith('.jsonl')) continue;
      const p = path.join(DIR, f);
      const st = fs.statSync(p);
      if (st.mtimeMs < cutoff) fs.unlinkSync(p);
    }
  } catch {}
}

/** 可用日期列表(倒序) */
function dates() {
  try {
    return fs.readdirSync(DIR).filter((f) => f.endsWith('.jsonl')).map((f) => f.slice(0, 10)).sort().reverse();
  } catch { return []; }
}

/** 查询某天日志: {total, rows, date};rows 按时间倒序,含 req/res 全量 */
// 按(文件, mtime)缓存原始文本: 省去每次读大文件;文件追加(mtime 变化)时自动重读
let _textCache = { file: null, mtime: -1, value: '' };
function readText(file) {
  let st = null;
  try { st = fs.statSync(file); } catch { return ''; }
  if (_textCache.file === file && _textCache.mtime === st.mtimeMs) return _textCache.value;
  let txt = '';
  try { txt = fs.readFileSync(file, 'utf8'); } catch {}
  _textCache = { file, mtime: st.mtimeMs, value: txt };
  return txt;
}

function list(date, opts = {}) {
  const file = path.join(DIR, String(date || dayKey(new Date())) + '.jsonl');
  let rows = [];
  const text = readText(file);
  if (text) {
    const lines = text.split('\n').filter(Boolean);
    rows = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  }
  if (opts.model) rows = rows.filter((r) => (r.model || '').includes(opts.model) || (r.usedModel || '').includes(opts.model));
  if (opts.status) rows = rows.filter((r) => String(r.status) === String(opts.status));
  if (opts.q) rows = rows.filter((r) => JSON.stringify(r.req || {}).toLowerCase().includes(opts.q.toLowerCase()));
  rows.sort((a, b) => (b.t || 0) - (a.t || 0)); // 最新在前
  const total = rows.length;
  const from = Math.max(0, parseInt(opts.offset || '0', 10));
  const size = Math.min(200, parseInt(opts.limit || '50', 10));
  const resLimit = parseInt(opts.resLimit || (32 * 1024).toString(), 10);  // API 返回的响应原文上限(磁盘文件保留完整)
  const reqLimit = parseInt(opts.reqLimit || (16 * 1024).toString(), 10);    // 请求体上限(防止列表响应过大导致前端卡死)
  const out = rows.slice(from, from + size).map((r) => {
    const o = { ...r };
    if (o.res && typeof o.res === 'string' && o.res.length > resLimit) {
      o.res = o.res.slice(0, resLimit); o.resClipped = true;
    }
    if (o.req && typeof o.req === 'object') {
      const js = JSON.stringify(o.req);
      if (js.length > reqLimit) { o.req = js.slice(0, reqLimit); o.reqTruncated = true; }
    }
    return o;
  });
  return { total, date: String(date || dayKey(new Date())), rows: out };
}

module.exports = { log, cleanup, dates, list, DIR, KEEP_DAYS, MAX_REC, MAX_REQ };