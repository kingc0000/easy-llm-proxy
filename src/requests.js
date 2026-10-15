/**
 * requests.js — 调用日志(全量 LLM API 调用记录)
 *
 *  - 按天双文件落盘 REQUESTS_DIR/:
 *      <DAY>.jsonl        完整记录(含原始请求/返回,append-only)
 *      <DAY>.meta.jsonl   轻量元数据(小字段 + preview + 正文文件字节偏移 off/byteLen)
 *  - 列表查询只读 meta 文件(小,快),不解析大正文 → 查询不超时
 *  - 详情点击时按 off 随机读回该行完整 JSON(正文最大 REQUESTS_MAX_REC/REQUESTS_MAX_REQ,
 *    写入前已截断)
 *  - 记录范围 = 所有到达 /v1 的调用: 转发成功/失败(上游状态码)、401 拒绝、413 超限、
 *    /v1/models 等,区别仅在于是否有正文
 *  - 文件权限 600(可能含敏感对话内容);自动清理 REQUESTS_KEEP_DAYS(默认 7)天前的双文件
 */
'use strict';
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { createReadStream } = fs;
const { StringDecoder } = require('string_decoder');

const DIR = process.env.REQUESTS_DIR || '/var/lib/easy-llm-proxy/requests';
const KEEP_DAYS = parseInt(process.env.REQUESTS_KEEP_DAYS || '7', 10);
const MAX_REC = parseInt(process.env.REQUESTS_MAX_REC || (512 * 1024).toString(), 10); // 响应原文截断字节
const MAX_REQ = parseInt(process.env.REQUESTS_MAX_REQ || (1024 * 1024).toString(), 10); // 请求体截断字节
const MAX_LINE_BYTES = MAX_REQ * 4 + MAX_REC * 4 + 4096; // 单行字节上限: MAX_* 按字符计, UTF-8 中文最多 4 字节/字符
const PREVIEW_LEN = 300; // 列表元数据里的正文预览长度(q 搜索范围)

function dayKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}
function filePath(day, meta) { return path.join(DIR, day + (meta ? '.meta.jsonl' : '.jsonl')); }

/* ---------------- 串行追加器(保证正文/元数据偏移一致) ---------------- */
const _states = new Map(); // day -> { fullBytes, tail }
function dayState(day) {
  let st = _states.get(day);
  if (!st) {
    let fullBytes = 0;
    try { fullBytes = fs.statSync(filePath(day, false)).size; } catch {}
    st = { fullBytes, tail: Promise.resolve() };
    _states.set(day, st);
  }
  return st;
}

/** 提取元数据行(小字段 + preview,不含完整 req/res) */
function pickMeta(rec) {
  let preview = rec.error && typeof rec.error === 'string' ? rec.error.slice(0, 120) : '';
  let reqPrev = '';
  try {
    if (rec.req && typeof rec.req === 'object') { const js = JSON.stringify(rec.req); reqPrev = js.slice(0, 200); }
    else if (typeof rec.req === 'string') {
      // 拍平后的纯文本对话记录: 预览跳过开头的「请求参数:」行, 直接给消息正文(信息密度更高)
      let s = rec.req;
      if (s.startsWith('请求参数:')) {
        const i = s.indexOf('\n\n');
        if (i >= 0) s = s.slice(i + 2) || '(仅参数,无消息)';
        // 无 '\n\n' 说明只有参数行(无消息), 保留参数行原样而非从 i+2=1 处切
      }
      reqPrev = s.slice(0, 200);
    }
  } catch {}
  let resPrev = '';
  if (typeof rec.res === 'string') resPrev = rec.res.slice(0, PREVIEW_LEN);
  if (reqPrev) preview = preview ? `${preview} | ${reqPrev}` : reqPrev;
  if (resPrev) preview = preview ? `${preview} | ${resPrev}` : resPrev;
  return {
    t: rec.t,
    provider: rec.provider || null,
    apiType: rec.apiType || null,
    path: rec.path || null,
    method: rec.method || null,
    model: rec.model ?? null,
    usedModel: rec.usedModel ?? null,
    key: rec.key ?? null,
    status: rec.status ?? null,
    ms: rec.ms ?? 0,
    attempts: rec.attempts || 0,
    // 同一次客户端调用的尝试链: final=true 为最终记录, attemptIdx=该记录是第几次尝试
    attemptIdx: rec.attemptIdx || 0,
    final: rec.final !== false,
    traceId: rec.traceId || null,
    degraded: !!rec.degraded,
    error: rec.error && typeof rec.error === 'string' ? rec.error.slice(0, 120) : null,
    reason: rec.reason && typeof rec.reason === 'string' ? rec.reason.slice(0, 80) : null,
    ingressKey: rec.ingressKey || null,
    promptTokens: rec.promptTokens || 0,
    cachedTokens: rec.cachedTokens || 0,
    completionTokens: rec.completionTokens || 0,
    truncated: !!rec.truncated,
    reqTruncated: !!rec.reqTruncated,
    reqSize: rec.reqSize || 0,
    hasBody: !!rec.req || !!rec.res,
    preview,
  };
}

/** 追加一条日志 = 写大正文行 + 写元数据行(异步串行,不阻塞请求) */
function log(rec) {
  try {
    const day = dayKey(new Date(rec.t || Date.now()));
    const st = dayState(day);
    if (st.locked) {
      // rewriteDay 重写窗口内: 延后写入。若此刻直接 append, 新行落在旧文件上,
      // rename 原子替换后该行使正文与元数据同时丢失
      (st.deferred = st.deferred || []).push(rec);
      return;
    }
    const { logged, resChunks, ...rest } = rec;
    const fullLine = JSON.stringify(rest) + '\n';
    const lineBytes = Buffer.byteLength(fullLine);
    fs.mkdirSync(DIR, { recursive: true });
    // off 在 tail 链内分配(与真实追加位置一致): 前一行 append 失败时 fullBytes 不递增,
    // 后续行不会指向空洞。此前在链外预分配 off + 失败后回退 fullBytes,
    // 但已排队的后续行 off 不会重算,而 appendFile 总追加到真实末尾 → 偏移永久错位。
    st.tail = st.tail
      .then(() => new Promise((res2) => {
        const off = st.fullBytes;
        fs.appendFile(filePath(day, false), fullLine, { mode: 0o600 }, (e) => {
          if (e) return res2(e);   // 正文写失败(磁盘满等): 不递增 off 基线、不写元数据 ——
                                   // 两阶段失败会留下「meta 指向不存在的正文」的行,偏移永久错位;
                                   // 整行跳过则该行对列表不可见但正文未污染,可由 backfillFile 重建
          st.fullBytes = off + lineBytes;
          const meta = { ...pickMeta(rest), off, byteLen: lineBytes - 1 }; // byteLen 不含换行
          fs.appendFile(filePath(day, true), JSON.stringify(meta) + '\n', { mode: 0o600 }, () => res2());
        });
      }))
      .catch(() => {});
  } catch { /* 日志失败不阻塞主流程 */ }
}

/** 清理过期日志文件(启动时与每日调用): 正文 + 元数据成对清理 */
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

/** 可用日期列表(倒序,只列正文文件) */
function dates() {
  try {
    return fs.readdirSync(DIR)
      .filter((f) => f.endsWith('.jsonl') && !f.endsWith('.meta.jsonl'))
      .map((f) => f.slice(0, 10)).sort().reverse();
  } catch { return []; }
}

/** 匹配过滤器(基于元数据行;q 匹配 preview + model/status/key) */
function makeMatcher(opts) {
  const model = (opts.model || '').toLowerCase();
  const status = String(opts.status || '');
  const q = (opts.q || '').toLowerCase();
  // final: 1=只看每次客户端调用的最终记录;0=只看被重试掉的中间尝试(429/5xx/超时);空=全部
  const fin = String(opts.final || '');
  return (r) => {
    if (model && !((r.model || '').toLowerCase().includes(model) || (r.usedModel || '').toLowerCase().includes(model))) return false;
    if (status && String(r.status) !== status) return false;
    if (fin === '1' && r.final === false) return false;
    if (fin === '0' && r.final !== false) return false;
    if (q) {
      const hay = ((r.preview || '') + ' ' + (r.model || '') + ' ' + (r.usedModel || '') + ' ' + (r.key || '') + ' ' + (r.provider || '')).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  };
}

/** 读某天所有元数据行(meta 文件很小;失败返回 null → 调用方走回退) */
function readMetaAll(day) {
  return new Promise((resolve) => {
    let st;
    try { st = fs.statSync(filePath(day, true)); } catch { return resolve(null); }
    if (!st || !st.size) return resolve([]);
    const rows = [];
    const rl = readline.createInterface({ input: createReadStream(filePath(day, true)), crlfDelay: Infinity });
    rl.on('line', (l) => { if (!l.trim()) return; try { rows.push(JSON.parse(l)); } catch {} });
    rl.on('close', () => resolve(rows));
    rl.on('error', () => resolve(null));
  });
}

/**
 * 列表查询(元数据,不含 req/res 正文):
 *   {total, date, rows, metaMode:boolean}
 *   rows 按时间倒序(最新在前,meta 文件按写入顺序即时间正序 → 反转)
 *   metaMode=false 表示该天没有 meta 文件(旧版日志),走正文流式回退(慢但可用)
 */
async function list(date, opts = {}) {
  const day = String(date || dayKey(new Date()));
  const offset = Math.max(0, parseInt(opts.offset || '0', 10));
  const size = Math.min(500, parseInt(opts.limit || '50', 10));
  const match = makeMatcher(opts);

  const meta = await readMetaAll(day);
  if (meta) {
    const hit = meta.filter(match);          // 保持文件顺序(时间正序)
    const total = hit.length;
    const rows = hit.slice(Math.max(0, total - offset - size), Math.max(0, total - offset)).reverse();
    return { total, date: day, rows, metaMode: true };
  }

  // 回退: 无 meta 的旧日期,流式扫正文文件,逐行解析只取元数据字段
  const file = filePath(day, false);
  let st;
  try { st = fs.statSync(file); } catch { st = null; }
  if (!st || !st.size || size <= 0) return { total: 0, date: day, rows: [], metaMode: false };
  const snap = st.size;
  return new Promise((resolve) => {
    const out = [];
    let total = 0;
    let pos = 0;
    const rl = readline.createInterface({ input: createReadStream(file, { end: snap }), crlfDelay: Infinity });
    rl.on('line', (l) => {
      const lb = Buffer.byteLength(l);   // 字节数推进: l.length 是字符数, 中文行会累积偏移误差
      if (!l.trim()) { pos += lb + 1; return; }
      let r; try { r = JSON.parse(l); } catch { pos += lb + 1; return; }
      const row = { ...pickMeta(r), off: pos, byteLen: lb };
      pos += lb + 1;
      if (!match(row)) return;
      total++;
      out.push(row);
      if (out.length > offset + size) out.shift(); // 只保留尾部窗口
    });
    rl.on('close', () => {
      const want = Math.min(size, Math.max(0, total - offset));
      // out 是尾部窗口(最后 offset+size 条,文件顺序):[total-offset-size, total-offset) 恰为 out 前 want 条
      // 修复: 此前 slice(out.length-waint) 取「最后 want 条」,与 meta 路径(从尾部偏移)语义相反 ——
      // offset 翻页时两条路径返回完全不同的记录集
      const rows = out.slice(0, want).reverse();
      resolve({ total, date: day, rows, metaMode: false });
    });
    rl.on('error', () => resolve({ total: 0, date: day, rows: [], metaMode: false }));
  });
}

/** 详情: 按字节偏移随机读回正文行完整 JSON(含 req/res;点击查看时才取) */
function detail(date, off, byteLen) {
  const day = String(date || dayKey(new Date()));
  const file = filePath(day, false);
  const offN = parseInt(off, 10);
  const lenN = Math.min(parseInt(byteLen || '0', 10), MAX_LINE_BYTES);
  return new Promise((resolve, reject) => {
    if (!Number.isFinite(offN) || offN < 0) return reject(new Error('bad offset'));
    const end = (Number.isFinite(lenN) && lenN > 0) ? offN + lenN : offN + MAX_LINE_BYTES;
    const chunks = [];
    const rs = createReadStream(file, { start: offN, end });
    rs.on('data', (c) => chunks.push(c));
    rs.on('end', () => {
      const buf = Buffer.concat(chunks);
      const nl = buf.indexOf(0x0a);
      const line = (nl >= 0 ? buf.slice(0, nl) : buf).toString('utf8');
      try { resolve(JSON.parse(line)); } catch (e) { reject(new Error('parse failed: ' + e.message)); }
    });
    rs.on('error', (e) => reject(e));
  });
}

/**
 * 启动时自愈: 为缺失元数据的旧日志正文文件一次性补建索引(旧版本日志只有 .jsonl)。
 * 补建后列表查询走 meta 文件(小),不必再流式扫描数百 MB 正文 → 查询不超时。
 * 同步执行且必须在本进程开始接收 /v1 请求之前调用(本进程是唯一写入方,避免索引与新增记录交叉)。
 * @returns {number} 补建的记录条数
 */
/** 为单日正文日志补建索引;返回 {indexed, body, skipped, why}
 *  写入 tmp 完成后原子 rename,中途失败不会留下"残缺且被误判已索引"的 meta。 */
function backfillFile(day, opts = {}) {
  const metaFile = filePath(day, true);
  const body = filePath(day, false);
  try {
    const ms = fs.statSync(metaFile);
    if (ms && ms.size > 0 && !opts.force) return { indexed: 0, skipped: true, why: 'exists' };
  } catch {}
  let st;
  try { st = fs.statSync(body); } catch { return { indexed: 0, skipped: true, why: 'no-body' }; }
  if (!st || !st.size) return { indexed: 0, skipped: true, why: 'empty' };
  const tmp = metaFile + '.tmp';
  try { fs.rmSync(tmp, { force: true }); } catch {}
  const done = _backfillOne(body, tmp);
  if (done <= 0) return { indexed: 0, skipped: true, why: 'no-rows' };
  try { fs.renameSync(tmp, metaFile); } catch { return { indexed: 0, skipped: true, why: 'rename' }; }
  return { indexed: done, body: st.size };
}

/** 补建目录下所有缺 meta 的日期;返回补建总条数。仅在显式 opt-in 时调用。 */
function backfill() {
  let dirs = [];
  try { dirs = fs.readdirSync(DIR); } catch { return 0; }
  let total = 0;
  const files = dirs.filter((f) => f.endsWith('.jsonl') && !f.endsWith('.meta.jsonl')).sort();
  for (const f of files) {
    const r = backfillFile(f.slice(0, 10));
    total += r.indexed;
    if (r.indexed > 0) console.log(`[requests] backfill ${f}: 补建 ${r.indexed} 条元数据索引`);
  }
  return total;
}

/** 为单个正文日志补建索引(同步,有界内存:1MB 分块读,不整文件驻留)。
 *  写 <tmp>,由调用方 rename;返回索引条数。
 *  pos 按每行真实占用的字节推进(含换行/\r),保证 off/byteLen 与文件真实字节严格一致。
 *  单行解析失败:跳过该条(正文保留,列表不可见),不写墓碑行以免污染列表。
 *  必须保持同步:调用方(server.js 启动钩子、bin/index-logs.js、测试)按同步返回值计数。
 *  早前用 readline 流实现的版本误返回 Promise,调用方读到 [object Promise] → 计数恒为 0。 */
function _backfillOne(body, tmp) {
  let fd;
  try { fd = fs.openSync(body, 'r'); } catch { return 0; }
  const CHUNK = 1024 * 1024;
  const buf = Buffer.allocUnsafe(CHUNK);
  const out = [];
  let pos = 0, written = 0;
  let carry = null;   // 上一块尾部未完成的行;下一轮 read 会覆写 buf,故必须拷贝
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, CHUNK, null);
      if (n === 0) break;
      const chunk = carry ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
      carry = null;
      let start = 0;
      for (;;) {
        const nl = chunk.indexOf(0x0a, start);
        if (nl < 0) break;
        const end = nl > start && chunk[nl - 1] === 0x0d ? nl - 1 : nl;   // 容忍 \r\n
        const byteLen = end - start;
        if (byteLen > 0) {
          let rec = null;
          try { rec = JSON.parse(chunk.subarray(start, end).toString('utf8')); } catch { /* 单行损坏:跳过 */ }
          if (rec) {
            out.push({ ...pickMeta(rec), off: pos, byteLen });
            if (out.length >= 200) { const b = out.splice(0); if (!_flushMeta(tmp, b)) throw new Error('meta write failed'); written += b.length; }
          }
        }
        pos += nl - start + 1;   // 该行字节 + 换行
        start = nl + 1;
      }
      if (start < chunk.length) carry = Buffer.from(chunk.subarray(start));
    }
    // 文件末尾无换行的最后一行
    if (carry && carry.length) {
      const end = carry[carry.length - 1] === 0x0d ? carry.length - 1 : carry.length;
      let rec = null;
      try { rec = JSON.parse(carry.subarray(0, end).toString('utf8')); } catch { /* 跳过 */ }
      if (rec) out.push({ ...pickMeta(rec), off: pos, byteLen: end });
    }
    if (out.length) { const b = out.splice(0); if (!_flushMeta(tmp, b)) throw new Error('meta write failed'); written += b.length; }
  } catch {
    // 扫描或写入中断: 删除 tmp, 避免残缺索引被 rename 成正式 meta(残缺 meta 会让已索引行对列表不可见)
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
  }
  return written;
}

/** 批量把索引行追加进 tmp(有界内存: 每批 200 条,不整文件驻留);返回是否写成功 */
function _flushMeta(tmp, rows) {
  try {
    const fh = fs.openSync(tmp, 'a', 0o600);
    for (const r of rows) fs.writeSync(fh, JSON.stringify(r) + '\n');
    fs.closeSync(fh);
    return true;
  } catch { return false; }
}

/* ---------------- 按时间区间清理(精确到分钟) ---------------- */

/** 解析分钟精度时间串 → 本地时区该分钟起点毫秒时间戳;非法/空返回 null
 *  支持 2026-10-14T22:05 / 2026-10-14 22:05 / 2026-10-14 22:05:30(秒被忽略) */
function parseMinute(s) {
  const m = String(s || '').trim().replace('T', ' ').replace(/[-/.]/g, '-').match(
    /^(\d{4})-(\d{1,2})-(\d{1,2})[ T]?(\d{1,2}):(\d{1,2})(?::\d{1,2})?/);
  if (!m) return null;
  const t = new Date(m[1], Number(m[2]) - 1, m[3], m[4], m[5], 0, 0).getTime();
  return Number.isFinite(t) ? t : null;
}

/** 区间边界 [fromStart, toStart+60s):from 从该分钟 00 秒起,to 包含整分钟 */
function rangeBounds(from, to) {
  const a = parseMinute(from);
  if (a == null) return null;
  const b = parseMinute(to);
  const toTs = b == null ? a + 60000 : b + 60000;
  if (toTs <= a) return null;   // to 早于/等于 from: 无效区间(原实现退化成 1ms, 静默只删一条)
  return [a, toTs];
}

/** 等待某天待写日志全部落盘(重写前避免与新增 append 交叉) */
function drainDay(day) {
  const st = _states.get(day);
  if (st && st.tail) return Promise.resolve(st.tail).catch(() => {});
  return Promise.resolve();
}

/** 批量落盘: 正文行原样保留(Buffer 字节一致),元数据由完整记录重新派生
 *  off 基于 tmp 文件已写入字节累加(不是原文件偏移);返回本批写入的正文字节数 */
function _flushRows(tmpBody, tmpMeta, rows, startOff) {
  let off = startOff;
  const fb = fs.openSync(tmpBody, 'a', 0o600);
  const fm = fs.openSync(tmpMeta, 'a', 0o600);
  try {
    for (const r of rows) {
      fs.writeSync(fb, r.line + '\n');
      // 单行损坏(rec=null)保留正文但不重建索引,与 backfill 行为一致
      if (r.rec) fs.writeSync(fm, JSON.stringify({ ...pickMeta(r.rec), off, byteLen: r.len }) + '\n');
      off += r.len + 1;
    }
  } finally { fs.closeSync(fb); fs.closeSync(fm); }
  return off - startOff;
}

/** 流式扫正文文件(有界内存),按 [from,to) 过滤;dryRun 只统计不落盘
 *  偏移以 tmp 文件为准: written 只累加保留行字节,被删行不参与累计 */
function _scanFilter(body, from, to, dryRun, tmpBody, tmpMeta) {
  return new Promise((resolve) => {
    const rows = [];
    let written = 0, removed = 0, kept = 0, keptBytes = 0;
    const rl = readline.createInterface({ input: createReadStream(body), crlfDelay: Infinity });
    rl.on('line', (line) => {
      const len = Buffer.byteLength(line);
      if (!line) return;
      let rec; try { rec = JSON.parse(line); } catch { rec = null; }
      const t = rec && Number(rec.t);
      if (Number.isFinite(t) && t >= from && t < to) { removed++; return; }
      kept++;
      keptBytes += len + 1; // 含换行,供 dryRun 预估可释放字节
      if (!dryRun) {
        rows.push({ line, len, rec });
        if (rows.length >= 200) written += _flushRows(tmpBody, tmpMeta, rows.splice(0), written);
      }
    });
    rl.on('close', () => {
      if (!dryRun && rows.length) written += _flushRows(tmpBody, tmpMeta, rows.splice(0), written);
      resolve({ removed, kept, written, keptBytes });
    });
    rl.on('error', () => resolve({ removed: -1, kept: -1, written: 0, keptBytes: 0 }));
  });
}

/** 重写单天日志: 删除区间内记录 + 重建元数据索引(偏移随行删除而变化);无命中则原样不动 */
async function rewriteDay(day, from, to, dryRun) {
  const bodyFile = filePath(day, false);
  const metaFile = filePath(day, true);
  let bodyBytes = 0;
  try { bodyBytes = fs.statSync(bodyFile).size; } catch { return { day, removed: 0, kept: 0, bodyBytes: 0, freed: 0 }; }
  if (!bodyBytes) return { day, removed: 0, kept: 0, bodyBytes: 0, freed: 0 };
  const _st = dayState(day);   // 确保条目存在, 以便捕获并发 log 的写入锁
  if (!dryRun) _st.locked = true;   // 锁定: 窗口内新 log 延后, 避免 append 到旧文件后被 rename 丢弃
  try {
  await drainDay(day);   // 扫描前等待待写日志全部落盘, 避免扫描结果与已写入内容不一致
  const tmpBody = bodyFile + '.tmp', tmpMeta = metaFile + '.tmp';
  // dryRun 只读扫,不落盘也不建 tmp 文件
  if (!dryRun) {
    try { fs.writeFileSync(tmpBody, '', { mode: 0o600 }); fs.writeFileSync(tmpMeta, '', { mode: 0o600 }); } catch {}
  }
  const r = await _scanFilter(bodyFile, from, to, dryRun, tmpBody, tmpMeta);
  const rmTmp = () => { if (!dryRun) { try { fs.rmSync(tmpBody, { force: true }); fs.rmSync(tmpMeta, { force: true }); } catch {} } };
  if (r.removed < 0) {
    rmTmp();
    return { day, removed: 0, kept: 0, bodyBytes, freed: 0, error: 'scan failed' };
  }
  if (dryRun) {
    // 预估可释放字节 = 正文总字节 - 保留行字节(含换行)
    return { day, removed: r.removed, kept: r.kept, bodyBytes, keptBytes: r.keptBytes, freed: Math.max(0, bodyBytes - r.keptBytes) };
  }
  if (r.removed === 0) {
    rmTmp();
    return { day, removed: 0, kept: r.kept, bodyBytes, freed: 0 };
  }
  // 原子替换(与 backfill 一致: tmp 完成后再 rename)
  fs.renameSync(tmpBody, bodyFile);
  fs.renameSync(tmpMeta, metaFile);
  let keptBytes = bodyBytes, freed = 0;
  try { keptBytes = fs.statSync(bodyFile).size; freed = bodyBytes - keptBytes; } catch {}
  if (keptBytes === 0) {
    // 该天记录全被清空: 删除空的双文件并重置写入状态
    try { fs.unlinkSync(bodyFile); fs.unlinkSync(metaFile); _states.delete(day); } catch {}
  } else {
    const st = dayState(day); st.fullBytes = keptBytes;
  }
  return { day, removed: r.removed, kept: r.kept, bodyBytes, keptBytes, freed };
  } finally {
    if (!dryRun) {
      // 用 _st(开始时获取的条目引用)而非 _states.get(day): keptBytes=0 时 _states 条目已被删除,
      // 但延后记录挂在 _st.deferred 上, 从新建条目读会丢失; 回放时 log 会重新定位条目
      _st.locked = false;
      const d = _st.deferred;
      _st.deferred = null;
      if (d && d.length) {
        // 延后记录回放: 挂到 tail 链保持顺序; log 内部按 rec.t 重新定位天与条目并写入
        _st.tail = _st.tail.then(() => { d.forEach((r) => log(r)); return Promise.resolve(); });
      }
    }
  }
}

/**
 * 按时间区间清理调用日志(精确到分钟)。
 *   from/to 形如 2026-10-14T22:05(本地时区,秒被忽略);
 *   实际删除 t ∈ [from 该分钟起点, to 该分钟结束),即 to 那整分钟也包含;
 *   不传 to 时只删 from 那一分钟。dryRun=true 只统计不删除。
 * @returns {Promise<object>} {ok, dryRun, fromTs, toTs, totalRemoved, totalFreed, days:[]}
 */
async function purgeRange(from, to, dryRun = false) {
  const b = rangeBounds(from, to);
  if (!b) {
    // parseMinute(from) 为 null 是格式错误; from 有效而 rangeBounds 为 null 是 to 早于 from
    const err = parseMinute(from) == null ? 'from/to 无效: 需形如 2026-10-14T22:05(精确到分钟)' : 'to 不能早于 from';
    return { ok: false, error: err };
  }
  const [fromTs, toTs] = b;
  const days = [];
  let totalRemoved = 0, totalFreed = 0;
  for (const d of dates()) {
    const dayStart = parseMinute(d + 'T00:00');
    if (!Number.isFinite(dayStart) || dayStart >= toTs) continue;          // 该天在区间之后
    if (dayStart + 86400000 <= fromTs) continue;                            // 该天在区间之前
    const r = await rewriteDay(d, fromTs, toTs, dryRun);
    if (r.removed > 0) totalRemoved += r.removed;
    totalFreed += r.freed || 0;
    days.push(r);
  }
  return {
    ok: true, dryRun: !!dryRun, fromTs, toTs,
    from: new Date(fromTs).toISOString(), to: new Date(toTs).toISOString(),
    totalRemoved, totalFreed, totalDays: days.length, days,
  };
}

module.exports = { log, cleanup, dates, list, detail, backfill, backfillFile, purgeRange, DIR, KEEP_DAYS, MAX_REC, MAX_REQ };