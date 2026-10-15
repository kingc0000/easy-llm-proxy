#!/usr/bin/env node
/*
 * bin/index-logs.js — 离线为旧调用日志补建元数据索引(.meta.jsonl)
 *
 * ⚠ 使用前提: 先 systemctl stop easy-llm-proxy.service。
 *   索引与 log() 共用同一个正文文件,服务运行中重建会产生偏移错位。
 *   服务本身绝不会自动跑这个动作(见 src/server.js 注释与 2026-10-14 事故)。
 *
 * 为什么需要它: log() 是双写(正文 + meta),但版本升级前的历史日志只有正文文件。
 *   没有 meta 的日期, /api/requests 列表会降级为流式扫描整个文件(大文件会超时)。
 *   本脚本用有界内存逐行扫描重建索引(tmp 文件 + 原子 rename,中途失败不会留下残缺索引)。
 *
 * 用法:
 *   systemctl stop easy-llm-proxy.service
 *   node bin/index-logs.js [--dir <REQUESTS_DIR>] [--force] [--dry-run]
 */
'use strict';
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const FORCE = args.includes('--force');
const di = args.indexOf('--dir');
if (di >= 0 && args[di + 1]) process.env.REQUESTS_DIR = args[di + 1];

const requests = require('../src/requests');
const DIR = requests.DIR;

function countLines(p) {
  const fh = fs.openSync(p, 'r');
  const b = Buffer.alloc(256 * 1024);
  let n = 0;
  try {
    for (;;) {
      const r = fs.readSync(fh, b, 0, b.length);
      if (r <= 0) break;
      for (let i = 0; i < r; i++) if (b[i] === 0x0a) n++;
    }
  } finally { fs.closeSync(fh); }
  return n;
}

function fmt(n) {
  if (n < 1024) return n + 'B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + 'KB';
  return (n / 1024 / 1024).toFixed(1) + 'MB';
}

const t0 = Date.now();
console.log(`[index-logs] 目录: ${DIR}`);
if (!fs.existsSync(DIR)) { console.log('[index-logs] 目录不存在,无需处理'); process.exit(0); }

let dirs = [];
try { dirs = fs.readdirSync(DIR).sort(); } catch (e) { console.error('[index-logs] 读取目录失败:', e.message); process.exit(1); }

let total = 0;
for (const f of dirs) {
  if (!f.endsWith('.jsonl') || f.endsWith('.meta.jsonl')) continue;
  const body = path.join(DIR, f);
  const meta = path.join(DIR, f.slice(0, 10) + '.meta.jsonl'); // 与 src/requests.js 的 filePath(day, true) 一致
  const sz = (p) => { try { return fs.statSync(p).size; } catch { return 0; } };
  let bs, ms;
  try { bs = fs.statSync(body); } catch { continue; }
  let hasMeta = false, msz = 0;
  try { ms = fs.statSync(meta); hasMeta = ms.size > 0; msz = ms.size; } catch {}
  if (hasMeta && !FORCE) { console.log(`  跳过 ${f}(已有索引 ${fmt(msz)})`); continue; }
  if (!bs.size) { console.log(`  跳过 ${f}(空文件)`); continue; }

  const lines = countLines(body);
  console.log(`  ${f} ${fmt(bs.size)} / ${lines} 行${DRY ? ' [dry-run]' : ''} ...`);
  total += lines;
  if (DRY) continue;

  const heapBefore = process.memoryUsage().heapUsed;
  const t1 = Date.now();
  const r = requests.backfillFile(f.slice(0, 10), { force: FORCE });
  let ok = false;
  const msize = sz(meta);
  let metaLines = 0;
  if (msize > 0) { try { metaLines = countLines(meta); } catch {} }
  ok = (msize > 0) && (metaLines === lines);
  const mb = (process.memoryUsage().heapUsed - heapBefore) / 1024 / 1024;
  console.log(`    → ${r.indexed > 0 ? `索引 ${r.indexed} 条` : `未索引(${r.why})`} | 索引文件 ${fmt(msize)} | 行数${ok ? '一致 ✓' : `不符 ${metaLines}/${lines} ✗`} | ${((Date.now() - t1) / 1000).toFixed(1)}s | Δheap ${mb.toFixed(1)}MB`);
  if (!ok) process.exitCode = 1;
}

console.log(`[index-logs] 完成,共 ${total} 行,耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
if (!total) console.log('[index-logs] 没有需要索引的文件');
if (!process.exitCode) console.log('[index-logs] 现在可以 systemctl start easy-llm-proxy.service');
else { console.error('[index-logs] 存在行数不符的索引,请检查后重试'); process.exit(1); }