/**
 * requests.test.js — 调用日志: 元数据列表(快) + 按字节偏移随机读详情(完整原文)
 *
 * 覆盖: 双文件落盘与权限、列表不含正文、过滤(模型/状态码/关键词)、分页、详情取回原文、
 *       无正文记录(401 拒绝)、旧日志(无 meta)回退、dates 排除 meta、cleanup 成对清理、
 *       快速连续 log 后偏移严格不重叠。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const TMP = path.join(__dirname, '.tmp-requests-test');
const RQ = path.join(TMP, 'req');
process.env.REQUESTS_DIR = RQ;

function dayOf(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const fileOf = (day, meta) => path.join(RQ, day + (meta ? '.meta.jsonl' : '.jsonl'));
const countLines = (p) => { try { return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).length; } catch { return 0; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 等待异步落盘完成(meta 与正文行数都达到 n) */
async function flush(day, n) {
  for (let i = 0; i < 120; i++) {
    if (countLines(fileOf(day, true)) === n && countLines(fileOf(day, false)) === n) return true;
    await sleep(20);
  }
  return countLines(fileOf(day, true)) === n && countLines(fileOf(day, false)) === n;
}
let rq;
async function reset() {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  delete require.cache[require.resolve('../src/requests')];
  rq = require('../src/requests');
}
function row(t, over = {}) {
  return Object.assign({
    t, provider: 'p', apiType: 'openai', model: 'm1', usedModel: 'm1', key: 'sk-abc',
    status: 200, ms: 10, attempts: 1, degraded: false, error: null,
    ingressKey: 'k1', promptTokens: 1, cachedTokens: 0, completionTokens: 1,
    req: { model: 'm1', messages: [{ role: 'user', content: 'hello world' }] },
    res: 'ok response body',
  }, over);
}

module.exports = async () => {
  const restored = process.env.REQUESTS_DIR;
  let failures = 0;
  const t = (name, fn) => Promise.resolve().then(fn).then(() => console.log('  ✓', name)).catch((e) => { failures++; console.log('  ✗', name, '\n    ', e.message); });

  await t('log 双文件落盘(正文 + 元数据),权限均 600', async () => {
    await reset();
    const day = dayOf(Date.now());
    rq.log(row(Date.now()));
    assert.ok(await flush(day, 1));
    assert.strictEqual(fs.statSync(fileOf(day, false)).mode & 0o777, 0o600);
    assert.strictEqual(fs.statSync(fileOf(day, true)).mode & 0o777, 0o600);
    const meta = JSON.parse(fs.readFileSync(fileOf(day, true), 'utf8').trim());
    const full = JSON.parse(fs.readFileSync(fileOf(day, false), 'utf8').trim());
    assert.strictEqual(typeof meta.off, 'number');
    assert.strictEqual(typeof meta.byteLen, 'number');
    assert.strictEqual(typeof meta.preview, 'string');
    assert.ok(!('req' in meta) && !('res' in meta), '元数据行不含原文正文');
    assert.strictEqual(full.res, 'ok response body', '正文行含完整 res');
  });

  await t('list 只返回元数据行(不含 req/res 原文),查询为 O(meta 文件)', async () => {
    await reset();
    const day = dayOf(Date.now());
    rq.log(row(Date.now() - 2000));
    rq.log(row(Date.now() - 1000));
    rq.log(row(Date.now()));
    assert.ok(await flush(day, 3));
    const d = await rq.list(day, { limit: '50' });
    assert.strictEqual(d.metaMode, true);
    assert.strictEqual(d.total, 3);
    assert.strictEqual(d.rows.length, 3);
    for (const r of d.rows) {
      assert.ok(!('req' in r) && !('res' in r), '列表行不携带正文');
      assert.ok(Number.isFinite(r.off), '行带字节偏移');
      assert.ok(Number.isFinite(r.byteLen), '行带字节长度');
      assert.strictEqual(r.model, 'm1');
    }
  });

  await t('list 按时间倒序(最新在前)', async () => {
    const day = dayOf(Date.now());
    const d = await rq.list(day, { limit: '50' });
    for (let i = 1; i < d.rows.length; i++) assert.ok(d.rows[i - 1].t >= d.rows[i].t);
  });

  await t('list 预览含请求与响应片段(用于关键词搜索)', async () => {
    const day = dayOf(Date.now());
    const d = await rq.list(day, { limit: '50' });
    assert.ok(d.rows[0].preview.includes('hello world'), '预览含 req 内容');
    assert.ok(d.rows[0].preview.includes('ok response body'), '预览含 res 内容');
  });

  await t('detail 按 off/byteLen 随机读回完整原文(req/res 齐全)', async () => {
    const day = dayOf(Date.now());
    const d = await rq.list(day, { limit: '50' });
    const f = await rq.detail(day, d.rows[0].off, d.rows[0].byteLen);
    assert.deepStrictEqual(f.req, { model: 'm1', messages: [{ role: 'user', content: 'hello world' }] });
    assert.strictEqual(f.res, 'ok response body');
    assert.strictEqual(f.model, 'm1');
    assert.strictEqual(f.ingressKey, 'k1');
  });

  await t('detail 无正文记录(401 拒绝)返回 req/res 为 null', async () => {
    const day = dayOf(Date.now());
    rq.log(row(Date.now(), { path: '/v1/chat/completions', method: 'POST', status: 401, error: 'invalid api key [invalid_api_key]', req: null, res: null, provider: null, model: null, usedModel: null }));
    assert.ok(await flush(day, 4));
    const d = await rq.list(day, { status: '401' });
    assert.strictEqual(d.total, 1);
    assert.strictEqual(d.rows[0].hasBody, false);
    const f = await rq.detail(day, d.rows[0].off, d.rows[0].byteLen);
    assert.strictEqual(f.req, null);
    assert.strictEqual(f.res, null);
    assert.strictEqual(f.status, 401);
  });

  await t('list 模型过滤(命中 model 与 usedModel)', async () => {
    const day = dayOf(Date.now());
    rq.log(row(Date.now() + 1000, { model: 'm1', usedModel: 'm2' }));
    assert.ok(await flush(day, 5));
    assert.strictEqual((await rq.list(day, { model: 'm1' })).total, 4);
    assert.strictEqual((await rq.list(day, { model: 'm2' })).total, 1);
    assert.strictEqual((await rq.list(day, { model: 'nope' })).total, 0);
  });

  await t('list 状态码过滤', async () => {
    const day = dayOf(Date.now());
    rq.log(row(Date.now() + 2000, { status: 429 }));
    assert.ok(await flush(day, 6));
    assert.strictEqual((await rq.list(day, { status: '429' })).total, 1);
    assert.strictEqual((await rq.list(day, { status: '401' })).total, 1);
  });

  await t('list q 命中 preview(搜响应正文内容)', async () => {
    const day = dayOf(Date.now());
    rq.log(row(Date.now() + 3000, { res: 'rate limit exceeded upstream' }));
    assert.ok(await flush(day, 7));
    assert.strictEqual((await rq.list(day, { q: 'rate limit' })).total, 1);
    assert.strictEqual((await rq.list(day, { q: 'hello world' })).total, 6);
  });

  await t('list 分页: offset/limit 与 total 一致', async () => {
    const day = dayOf(Date.now());
    for (let i = 0; i < 12; i++) rq.log(row(Date.now() + 10000 + i * 100));
    assert.ok(await flush(day, 19));
    const all = await rq.list(day, { limit: '50' });
    assert.strictEqual(all.total, 19);
    const p1 = await rq.list(day, { limit: '5', offset: '0' });
    const p2 = await rq.list(day, { limit: '5', offset: '5' });
    assert.strictEqual(p1.total, 19);
    assert.strictEqual(p2.total, 19);
    assert.strictEqual(p1.rows.length, 5);
    assert.strictEqual(p2.rows.length, 5);
    assert.ok(p1.rows[0].t > p2.rows[0].t, '第一页比第二页更新');
    assert.ok(!p1.rows.some((x) => p2.rows.includes(x)), '两页不重叠');
    const p3 = await rq.list(day, { limit: '5', offset: '15' });
    assert.strictEqual(p3.rows.length, 4);
  });

  await t('list 空天返回 total=0 且不报错', async () => {
    const d = await rq.list(dayOf(Date.now() + 86400000), {});
    assert.strictEqual(d.total, 0);
    assert.deepStrictEqual(d.rows, []);
  });

  await t('detail 偏移非法时 reject(bad offset)', async () => {
    const day = dayOf(Date.now());
    await assert.rejects(() => rq.detail(day, -1, 10));
    await assert.rejects(() => rq.detail(day, 'abc', 10));
  });

  await t('detail 指向不存在的天 reject', async () => {
    await assert.rejects(() => rq.detail(dayOf(Date.now() + 86400000), 0, 100));
  });

  await t('旧日志(无 meta 文件)走回退: metaMode=false 且仍给 off', async () => {
    const day = dayOf(Date.now() + 86400000);
    fs.mkdirSync(RQ, { recursive: true });
    fs.writeFileSync(fileOf(day, false), JSON.stringify(row(Date.now() + 90000)) + '\n' + JSON.stringify(row(Date.now() + 91000, { status: 500 })) + '\n', { mode: 0o600 });
    const d = await rq.list(day, {});
    assert.strictEqual(d.metaMode, false);
    assert.strictEqual(d.total, 2);
    for (const r of d.rows) {
      assert.ok(Number.isFinite(r.off) && r.off >= 0, '回退行偏移为合法值');
      assert.ok(Number.isFinite(r.byteLen) && r.byteLen > 0, '回退行长度为合法值');
    }
    const f = await rq.detail(day, d.rows[0].off, d.rows[0].byteLen);
    assert.strictEqual(f.status, 500, '回退行仍可按偏移取回原文');
  });

  await t('回退路径分页 offset 从尾部计,与 meta 路径语义一致(修复: 此前取反)', async () => {
    const day = dayOf(Date.now() + 172800000);
    fs.mkdirSync(RQ, { recursive: true });
    let body = '';
    for (let i = 0; i < 10; i++) body += JSON.stringify(row(Date.now() + 200000 + i * 1000, { model: 'm' + i })) + '\n';
    fs.writeFileSync(fileOf(day, false), body, { mode: 0o600 });
    try { fs.unlinkSync(fileOf(day, true)); } catch {}   // 确保走回退

    const p = async (o) => rq.list(day, { limit: '3', offset: String(o) });
    const p0 = await p(0), p1 = await p(3), p2 = await p(6), p3 = await p(9);
    assert.strictEqual(p0.total, 10);
    assert.deepStrictEqual(p0.rows.map((r) => r.model), ['m9', 'm8', 'm7'], 'offset=0 取最后 3 条');
    assert.deepStrictEqual(p1.rows.map((r) => r.model), ['m6', 'm5', 'm4'], 'offset=3 取倒数第 4-6 条');
    assert.deepStrictEqual(p2.rows.map((r) => r.model), ['m3', 'm2', 'm1'], 'offset=6 取第 1-3 条');
    assert.deepStrictEqual(p3.rows.map((r) => r.model), ['m0'], 'offset=9 不足一页只返回 1 条');
    try { fs.unlinkSync(fileOf(day, false)); } catch {}   // 清理,避免污染后续 cleanup 测试的近期文件断言
  });

  await t('尝试链元数据: final/attemptIdx/traceId/reason 进入 meta 与列表,按 traceId 可分组', async () => {
    await reset();
    const day = dayOf(Date.now());
    const t0 = Date.now() + 400000;
    // 同一次客户端调用: 第 1 次尝试 429(中间) → 第 2 次尝试 200(最终)
    rq.log(row(t0, { final: false, attemptIdx: 1, attempts: 3, traceId: 'tr-1', reason: 'status:429', status: 429, usedModel: 'm2', res: '{"error":"tpm limit"}' }));
    rq.log(row(t0 + 100, { final: true, attemptIdx: 2, attempts: 3, traceId: 'tr-1', status: 200 }));
    rq.log(row(t0 + 200, { final: true, traceId: 'tr-2', status: 502 }));
    assert.ok(await flush(day, 3));
    const d = await rq.list(day, { limit: '10' });
    assert.strictEqual(d.metaMode, true);
    assert.strictEqual(d.total, 3, '全部尝试都保留为独立记录');
    const tr1 = d.rows.filter((r) => r.traceId === 'tr-1').sort((a, b) => a.t - b.t);
    assert.strictEqual(tr1.length, 2, '同一次客户端调用的两条尝试按 traceId 可分组');
    assert.strictEqual(tr1[0].final, false, '中间尝试 final=false');
    assert.strictEqual(tr1[0].attemptIdx, 1, '中间尝试 attemptIdx 保留');
    assert.strictEqual(tr1[0].reason, 'status:429', '失败原因分类保留');
    assert.strictEqual(tr1[0].status, 429, '中间尝试的 429 状态码可查');
    assert.strictEqual(tr1[1].final, true, '最终记录 final=true');
    const old = d.rows.find((r) => r.traceId === 'tr-2');
    assert.strictEqual(old.final, true, '无中间尝试的记录默认为最终');
    assert.strictEqual(old.reason, null, '无 reason 为 null');
    // 详情仍能按偏移取回中间尝试的原文
    const det = await rq.detail(day, tr1[0].off, tr1[0].byteLen);
    assert.strictEqual(det.status, 429, '中间尝试详情可取回');
  });

  await t('列表按 final 过滤: final=1 只看最终记录, final=0 只看被重试的中间尝试', async () => {
    await reset();   // 清空目录, 避免与后续 cleanup 测试的近期文件断言冲突
    const day = dayOf(Date.now());
    const t0 = Date.now() + 500000;
    rq.log(row(t0, { final: false, attemptIdx: 1, attempts: 2, traceId: 'tr-f', status: 429 }));
    rq.log(row(t0 + 100, { final: true, attemptIdx: 2, attempts: 2, traceId: 'tr-f', status: 200 }));
    assert.ok(await flush(day, 2));
    const all = await rq.list(day, { limit: '10' });
    assert.strictEqual(all.total, 2, '不过滤返回全部尝试');
    const fin = await rq.list(day, { limit: '10', final: '1' });
    assert.strictEqual(fin.total, 1, 'final=1 只返回最终记录');
    assert.strictEqual(fin.rows[0].status, 200);
    const mid = await rq.list(day, { limit: '10', final: '0' });
    assert.strictEqual(mid.total, 1, 'final=0 只返回中间尝试');
    assert.strictEqual(mid.rows[0].status, 429, '中间尝试的 429 可单独筛出');
    assert.strictEqual(mid.rows[0].final, false);
    // 旧日志(final 字段缺失)在 final=1 下仍可见, 不回退为"中间尝试"
    fs.writeFileSync(fileOf(day, true),
      fs.readFileSync(fileOf(day, true), 'utf8')
      + JSON.stringify({ t: t0 + 200, provider: 'p', apiType: 'openai', model: 'm1', usedModel: 'm1', key: null, status: 200, ms: 5, attempts: 1, off: 0, byteLen: 0, preview: 'legacy' }) + '\n',
      { mode: 0o600 });
    const legacy = await rq.list(day, { limit: '10', final: '1' });
    assert.strictEqual(legacy.total, 2, '旧记录(final 缺失)视为最终, 不被过滤掉');
  });

  await t('dates 只返回正文明细日期(不含 .meta.jsonl)', async () => {
    const ds = rq.dates();
    for (const x of ds) assert.ok(!x.endsWith('.meta'));
    assert.strictEqual(new Set(ds).size, ds.length, '无重复');
  });

  await t('cleanup 成对清理过期双文件,保留近期文件', async () => {
    const oldDay = dayOf(Date.now() - 30 * 86400000);
    const old = path.join(RQ, oldDay + '.jsonl');
    const oldSt = Math.floor((Date.now() - 30 * 86400000) / 1000);
    fs.writeFileSync(old, '{}\n', { mode: 0o600 });
    fs.writeFileSync(path.join(RQ, oldDay + '.meta.jsonl'), '{}\n', { mode: 0o600 });
    fs.utimesSync(old, oldSt, oldSt);
    fs.utimesSync(path.join(RQ, oldDay + '.meta.jsonl'), oldSt, oldSt);
    const before = fs.readdirSync(RQ);
    rq.cleanup();
    const after = fs.readdirSync(RQ);
    assert.ok(before.includes(oldDay + '.jsonl'));
    assert.ok(!after.includes(oldDay + '.jsonl'), '过期正文文件已清');
    assert.ok(!after.includes(oldDay + '.meta.jsonl'), '过期元数据文件已清');
    for (const d of rq.dates()) assert.ok(after.includes(d + '.jsonl'), '近期正文文件仍在');
    for (const d of rq.dates()) {
      const hasMeta = after.includes(d + '.meta.jsonl');
      if (d !== dayOf(Date.now() + 86400000)) assert.ok(hasMeta, '近期元数据文件仍在(人工构造的无 meta 旧日志除外)');
    }
  });

  await t('快速连续 log 后偏移严格递增且互不重叠', async () => {
    await reset();
    const day = dayOf(Date.now());
    for (let i = 0; i < 30; i++) rq.log(row(Date.now() + i * 100, { res: 'body-' + i }));
    assert.ok(await flush(day, 30));
    const d = await rq.list(day, { limit: '50' });
    assert.strictEqual(d.total, 30);
    const offs = d.rows.map((r) => r.off).reverse(); // 时间正序
    for (let i = 1; i < offs.length; i++) assert.ok(offs[i] > offs[i - 1], '偏移严格递增');
    const body0 = await rq.detail(day, d.rows[29].off, d.rows[29].byteLen);
    const body29 = await rq.detail(day, d.rows[0].off, d.rows[0].byteLen);
    assert.strictEqual(body0.res, 'body-0', '最早一条取回正确(不串行)');
    assert.strictEqual(body29.res, 'body-29', '最新一条取回正确');
    const full = fs.readFileSync(fileOf(day, false), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.strictEqual(full.length, 30, '正文文件行数正确');
    for (let i = 0; i < 30; i++) assert.strictEqual(full[i].res, 'body-' + i, '正文文件顺序正确');
  });

  await t('元数据不含 key 哈希/完整正文,但保留脱敏名称', async () => {
    const day = dayOf(Date.now());
    const metaLines = fs.readFileSync(fileOf(day, true), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    for (const m of metaLines) {
      assert.ok(!/^[0-9a-f]{64}$/.test(m.preview || ''), 'preview 无哈希');
      assert.ok(m.preview.length < 800, 'preview 有上限');
      assert.strictEqual(typeof m.key, 'string', '元数据保留脱敏 key');
    }
  });

  await t('backfill 为旧日志补建索引: 列表改走 meta,详情仍按偏移取回完整原文', async () => {
    const day = dayOf(Date.now() + 3 * 86400000);
    fs.mkdirSync(RQ, { recursive: true });
    const legacy = [
      { t: Date.now() + 40000, provider: 'p', apiType: 'openai', model: 'm1', usedModel: 'm1', status: 200, ms: 1, req: { model: 'm1', messages: [{ role: 'user', content: '中文内容测试' }] }, res: '中文响应内容' },
      { t: Date.now() + 41000, provider: 'p', apiType: 'openai', model: 'm1', usedModel: 'm2', status: 200, ms: 2, req: { model: 'm1', messages: [{ role: 'user', content: 'x'.repeat(200000) }] }, res: 'y'.repeat(200000) },
      { t: Date.now() + 42000, provider: 'p', apiType: 'openai', model: 'm1', usedModel: 'm1', status: 429, ms: 3, error: 'rate limit', req: { model: 'm1' }, res: null },
    ];
    fs.writeFileSync(fileOf(day, false), legacy.map((l) => JSON.stringify(l)).join('\n') + '\n', { mode: 0o600 });
    const n = rq.backfill();
    assert.strictEqual(n, 3, '补建 3 条元数据');
    assert.ok(fs.existsSync(fileOf(day, true)), '元数据文件已生成');
    const metaLines = fs.readFileSync(fileOf(day, true), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.strictEqual(metaLines.length, 3);
    for (let i = 1; i < metaLines.length; i++) assert.ok(metaLines[i].off > metaLines[i - 1].off, '索引偏移严格递增');
    const d = await rq.list(day, {});
    assert.strictEqual(d.metaMode, true, '补建后列表走 meta 索引');
    assert.strictEqual(d.total, 3);
    const newest = await rq.detail(day, d.rows[0].off, d.rows[0].byteLen);
    assert.strictEqual(newest.status, 429, '最新一条按偏移取回正确');
    const big = await rq.detail(day, d.rows[1].off, d.rows[1].byteLen);
    assert.strictEqual(big.res.length, 200000, '大响应(含中文/长文本)字节偏移精确定位,不串行');
    assert.strictEqual(rq.backfill(), 0, '幂等: 已有索引不重复补建');
  });

  await t('backfill 返回值是同步数字(非 Promise): 调用方按返回值计数', async () => {
    // 回归: _backfillOne 曾用 readline 流实现误返回 Promise, 调用方(server.js/bin/index-logs.js)
    // 把 [object Promise] 当数字比较, 计数恒为 0, 索引实际已建但状态显示"未索引"。
    const day = dayOf(Date.now() + 4 * 86400000);
    fs.mkdirSync(RQ, { recursive: true });
    fs.writeFileSync(fileOf(day, false), [row(Date.now() + 60000), row(Date.now() + 61000)]
      .map(JSON.stringify).join('\n') + '\n', { mode: 0o600 });
    const n = rq.backfillFile(day);
    assert.strictEqual(typeof n, 'object', 'backfillFile 返回结果对象');
    assert.strictEqual(typeof n.indexed, 'number', '补建条数是同步数字(不是 Promise)');
    assert.strictEqual(n.indexed, 2, '返回实际补建条数');
    assert.deepStrictEqual(rq.backfillFile(day), { indexed: 0, skipped: true, why: 'exists' }, '已有索引幂等跳过');
    const all = rq.backfill();
    assert.strictEqual(typeof all, 'number', 'backfill 汇总也是同步数字');
    assert.strictEqual(rq.backfill(), 0, '再次调用幂等返回 0');
  });

  await t('backfill 跨分块边界(>1MB, 含中文): 偏移与内容仍精确', async () => {
    // _backfillOne 按 1MB 分块读; 多字节字符正好跨块时最容易读出乱码致 JSON.parse 失败而丢索引
    const day = dayOf(Date.now() + 5 * 86400000);
    const big = row(Date.now() + 70000, { res: '汉'.repeat(250000), model: 'big' });
    fs.writeFileSync(fileOf(day, false), [row(Date.now() + 70000), big, row(Date.now() + 72000)]
      .map(JSON.stringify).join('\n') + '\n', { mode: 0o600 });
    const n = rq.backfillFile(day);
    assert.strictEqual(n.indexed, 3, '含超大中文响应的 3 条全部补建');
    const meta = fs.readFileSync(fileOf(day, true), 'utf8').trim().split('\n').map(JSON.parse);
    for (let i = 1; i < meta.length; i++) assert.ok(meta[i].off > meta[i - 1].off, '偏移严格递增');
    const body = fs.readFileSync(fileOf(day, false));
    for (const m of meta) {
      const line = body.subarray(m.off, m.off + m.byteLen).toString('utf8');
      const parsed = JSON.parse(line);
      assert.ok(parsed.t > 0, '按偏移读回的行可解析');
      assert.ok(!line.includes('\uFFFD'), '按偏移读回不出现半字符乱码');
    }
    const d = await rq.list(day, {});
    assert.strictEqual(d.total, 3);
    const hit = d.rows.find((x) => x.model === 'big');
    assert.ok(hit, '大记录进入列表');
    const det = await rq.detail(day, hit.off, hit.byteLen);
    assert.strictEqual(det.res.length, 250000, '跨分块的中文响应完整读回');
  });

  await t('log 不阻塞主流程: 返回值同步、写盘异步', () => {
    assert.strictEqual(rq.log(row(Date.now())), undefined);
    assert.strictEqual(rq.log(row(Date.now(), { status: 401, req: null, res: null })), undefined);
  });

  // ---- 回归: 下列 bug 均已修复 ----

  await t('回退路径(无 meta)偏移按字节计: 中文行详情仍能完整读回', async () => {
    await reset();
    const day = dayOf(Date.now());
    fs.mkdirSync(RQ, { recursive: true });
    // 40 万个中文字符 ≈ 1.2MB, 远超旧的上限 MAX_REC+MAX_REQ+4096(1.07MB)
    const big = row(Date.now(), { model: 'cn', req: { model: 'cn', messages: [{ role: 'user', content: '中'.repeat(400000) }] } });
    fs.writeFileSync(fileOf(day, false), JSON.stringify(big) + '\n', { mode: 0o600 });
    const d = await rq.list(day, {});
    assert.strictEqual(d.metaMode, false, '无 meta 走回退');
    assert.strictEqual(d.total, 1);
    const r = d.rows[0];
    assert.strictEqual(r.byteLen, Buffer.byteLength(JSON.stringify(big)), '回退 byteLen 为字节数而非字符数');
    const det = await rq.detail(day, r.off, r.byteLen);
    assert.strictEqual(det.model, 'cn', '回退路径 offset 定位正确');
    assert.strictEqual(det.req.messages[0].content.length, 400000, '1.2MB 中文行完整读回(detail 上限按 UTF-8 4 字节/字符放宽)');
  });

  await t('meta 模式首行 off=0 时详情可读回', async () => {
    await reset();
    const day = dayOf(Date.now());
    rq.log(row(Date.now()));
    rq.log(row(Date.now() + 1000));
    assert.ok(await flush(day, 2));
    const d = await rq.list(day, {});
    const first = d.rows.find((x) => x.off === 0);
    assert.ok(first, 'meta 首行 off=0 存在');
    const det = await rq.detail(day, first.off, first.byteLen);
    assert.strictEqual(det.status, 200, 'off=0 的行可按偏移读回');
  });

  await t('purgeRange: to 早于 from 返回明确错误(而非静默只删 1ms 区间)', async () => {
    await reset();
    const d = await rq.purgeRange('2026-10-15T23:00', '2026-10-15T00:00', true);
    assert.strictEqual(d.ok, false);
    assert.match(d.error, /to 不能早于 from/);
    const d2 = await rq.purgeRange('2026-10-15T23:00', '', true);
    assert.strictEqual(d2.ok, true, '只传 from 仍正常');
  });

  await t('preview: 拍平文本仅参数行(无消息体)时不丢首字符', async () => {
    await reset();
    const day = dayOf(Date.now());
    rq.log(row(Date.now(), { req: '请求参数: model=m1, stream=true' }));
    assert.ok(await flush(day, 1));
    const meta = JSON.parse(fs.readFileSync(fileOf(day, true), 'utf8').trim());
    assert.ok(meta.preview.startsWith('请求参数:'), '单行参数原文保留, 未被 slice(1) 切掉首字符');
  });

  await t('purgeRange 重写窗口内并发写入不丢失(锁与延后回放)', async () => {
    await reset();
    const base = Date.now() - (Date.now() % 60000);
    const day = dayOf(base);
    for (let i = 0; i < 20; i++) rq.log(row(base + i * 2000));
    assert.ok(await flush(day, 20));
    const m = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}T${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`; };
    const newT = base + 120000;
    assert.strictEqual(dayOf(newT), day, '前提: 新记录与被删范围同一天');
    const p = rq.purgeRange(m(base), m(base + 60000), false);
    setTimeout(() => rq.log(row(newT)), 0);   // 重写窗口内并发写入, 应被锁延后而非丢失
    const r = await p;
    assert.ok(r.ok, 'purge 成功');
    assert.strictEqual(r.totalRemoved, 20, '窗口内 20 条全部删除');
    await sleep(200);   // 等延后记录回放落盘
    const d = await rq.list(day, {});
    assert.strictEqual(d.total, 1, '延后写入的新记录经回放保留, 未随 rename 丢失');
  });

  await t('log 正文写入失败: 回退 off 基线且不写元数据(避免偏移空洞)', async () => {
    await reset();
    const day = dayOf(Date.now());
    const realFile = fileOf(day, false);
    const origAppend = fs.appendFile;
    let failNext = false;
    fs.appendFile = function (p, data, opts, cb) {
      if (failNext && p === realFile) {
        failNext = false;
        const err = new Error('disk full');
        return typeof opts === 'function' ? opts(err) : cb(err);
      }
      return origAppend.call(fs, p, data, opts, cb);
    };
    try {
      const t0 = Date.now();
      failNext = true;
      rq.log(row(t0));                // 正文写失败 → 整行跳过(正文与元数据都不写)
      const t1 = Date.now() + 1000;
      rq.log(row(t1));                // 并发排队: 在失败行落盘结果返回前提交。
                                      // 旧实现此处已预分配 off=失败行长度,失败回退只改 fullBytes 基线、
                                      // 不改已分配的 off,而 appendFile 总追加到真实末尾 → 后续行永久错位
      assert.ok(await flush(day, 1));
      const lines = fs.readFileSync(fileOf(day, false), 'utf8').trim().split('\n');
      assert.strictEqual(lines.length, 1, '仅成功写入的行落盘, 失败行不留空位');
      const meta = JSON.parse(fs.readFileSync(fileOf(day, true), 'utf8').trim());
      assert.strictEqual(meta.off, 0, 'off 基线回退到正文真实末尾, 无空洞');
      const det = await rq.detail(day, meta.off, meta.byteLen);
      assert.strictEqual(det.t, t1, 'detail 按偏移读回正确行(而非错位到失败行的空位)');
    } finally {
      fs.appendFile = origAppend;
    }
  });

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  delete process.env.REQUESTS_DIR;
  console.log(`requests.test: ${31 - failures} pass / ${failures} fail`);
  return failures === 0;
};