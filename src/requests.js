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
// 流式读取(readline 逐行),不把整文件读进内存——修复 288MB jsonl 导致 Node OOM 崩溃(1.7G 内存机器)
const readline = require('readline');
const { createReadStream } = fs;

/** 第一次遍历: 统计命中数(用于 total),避免把全部行留在内存 */
function countMatching(file, match, snap) {
  return new Promise((resolve) => {
    let n = 0;
    const rl = readline.createInterface({ input: createReadStream(file, { end: snap }), crlfDelay: Infinity });
    rl.on('line', (l) => { if (!l.trim()) return; let r; try { r = JSON.parse(l); } catch { return; } if (match(r)) n++; });
    rl.on('close', () => resolve(n));
    rl.on('error', () => resolve(0));
  });
}

/** 第二次遍历: 收集 offset..offset+size 命中行(内存只保留页内记录) */
// 文件按时间正序追加;要"最新的 offset..offset+size 条命中" → 跳过文件头部旧命中 skipHead 条,
// 收集尾部窗口 want 条(内存 O(want)),再按 t 倒序输出
function collectPage(file, match, skipHead, want, snap) {
  return new Promise((resolve, reject) => {
    const out = [];
    let skip = skipHead;
    const rl = readline.createInterface({ input: createReadStream(file, { end: snap }), crlfDelay: Infinity });
    rl.on('line', (l) => {
      if (!l.trim()) return;
      let r; try { r = JSON.parse(l); } catch { return; }
      if (!match(r)) return;
      if (skip > 0) { skip--; return; }
      if (out.length < want) out.push(r);
    });
    rl.on('close', () => resolve({ out, seen: -1 }));
    rl.on('error', (e) => reject(e));
  });
}

async function list(date, opts = {}) {
  const file = path.join(DIR, String(date || dayKey(new Date())) + '.jsonl');
  const match = (r) => {
    if (opts.model && !((r.model || '').includes(opts.model) || (r.usedModel || '').includes(opts.model))) return false;
    if (opts.status && String(r.status) !== String(opts.status)) return false;
    if (opts.q && !JSON.stringify(r.req || {}).toLowerCase().includes(opts.q.toLowerCase())) return false;
    return true;
  };
  const offset = Math.max(0, parseInt(opts.offset || '0', 10));
  const size = Math.min(200, parseInt(opts.limit || '50', 10));
  const resLimit = parseInt(opts.resLimit || (32 * 1024).toString(), 10); // API 返回的响应原文上限(磁盘文件保留完整)
  const reqLimit = parseInt(opts.reqLimit || (16 * 1024).toString(), 10); // 请求体上限(防止列表响应过大导致前端卡死)

  let st;
  try { st = fs.statSync(file); } catch { st = null; }
  if (!st || !st.size || size <= 0) {
    return { total: 0, date: String(date || dayKey(new Date())), rows: [] };
  }
  const snap = st.size; // 快照截止点: 两遍扫描都扫到此为止,文件追加不会让 total 与窗口错位

  // 第一遍: 只统计命中总数(内存 O(1))
  const total = await countMatching(file, match, snap);
  // 要返回的条数(offset 之后不足 size 则有多少返多少)
  const want = Math.min(size, Math.max(0, total - offset));
  if (want <= 0) {
    return { total, date: String(date || dayKey(new Date())), rows: [] };
  }
  // 第二遍: 跳过文件头部旧命中,收集"最新 offset 起的 want 条"(内存 O(want))
  const skipHead = total - offset - want;
  const { out } = await collectPage(file, match, skipHead, want, snap);
  out.sort((a, b) => (b.t || 0) - (a.t || 0)); // 行内按时间倒序(最新在前)

  const rows = out.map((r) => {
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
  return { total, date: String(date || dayKey(new Date())), rows };
}

module.exports = { log, cleanup, dates, list, DIR, KEEP_DAYS, MAX_REC, MAX_REQ };