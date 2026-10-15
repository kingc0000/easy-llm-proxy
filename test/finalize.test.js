/**
 * finalize.test.js — 请求体拍平 + 请求/响应超限行为
 *
 * 背景 1: REQUESTS_MAX_REQ=16384 时 DSH 的 400-700KB 请求体被整条置空(reqTruncated 但 req=null),
 *         面板里完全看不到内容 → 改为截断保留前缀并记录原始字节数 reqSize。
 * 背景 2: 请求体原样落 JSON(带 messages/role/tools 定义/thinking), 62% 是结构与推理轨迹,
 *         用户只要"实际的请求内容" → 拍平成纯文本对话记录(REQUESTS_REQ_MODE=text)。
 *
 * 上限在 require 前通过环境变量注入(请求/响应记录上限在模块加载时读取)。
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const MARK = '\u2026[truncated]';
const PROXY = require.resolve('../src/proxy');

/** 日志隔离目录: logAttempt 测试会真实写盘, 不指向生产日志目录 */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'elap-fin-'));

/** 清 proxy 缓存并按 env 重新加载(REQ_MODE / MAX_* 均为模块加载期常量) */
function loadProxy(env = {}) {
  delete require.cache[require.resolve('../src/requests')];
  delete require.cache[PROXY];
  const old = { ...process.env };
  Object.assign(process.env, env);
  try { return require(PROXY); }
  finally {
    for (const k of Object.keys(process.env)) if (!(k in old)) delete process.env[k];
    Object.assign(process.env, old);
  }
}

process.env.REQUESTS_MAX_REQ = '4000';
process.env.REQUESTS_MAX_REC = '2000';
delete require.cache[require.resolve('../src/requests')];
delete require.cache[PROXY];

const { finalizeRec, flattenReq, REQ_MODE, logAttempt } = loadProxy({ REQUESTS_DIR: TMP });
const requests = require('../src/requests');
const MAX_REQ = requests.MAX_REQ;
const MAX_REC = requests.MAX_REC;

/** 一条多轮对话请求体: 含 system/user/assistant/tool 与 thinking、tool_calls、tools 定义 */
function chatReq() {
  return {
    model: 'm1',
    stream: true,
    stream_options: { include_usage: true },
    max_completion_tokens: 1024,
    tools: [{ type: 'function', function: { name: 'weather', parameters: { type: 'object' } } }],
    messages: [
      { role: 'system', content: 'SYS-PROMPT' },
      { role: 'user', content: '上海天气' },
      { role: 'assistant', content: '我查一下', reasoning_content: 'THINKING-TRACE-1', tool_calls: [
        { id: 'call_a1', type: 'function', function: { name: 'weather', arguments: '{"city":"上海"}' } },
      ] },
      { role: 'tool', tool_call_id: 'call_a1', name: 'weather', content: '{"temp":25}' },
      { role: 'assistant', content: '上海 25 度', reasoning: 'THINKING-TRACE-2' },
    ],
  };
}

module.exports = async () => {
  let failures = 0;
  let passes = 0;
  const t = (name, fn) => Promise.resolve().then(fn).then(() => { passes++; console.log('  ✓', name); }).catch((e) => { failures++; console.log('  ✗', name, '\n    ', e.message); });
  const rec = (over = {}) => Object.assign(
    { t: Date.now(), provider: 'p', apiType: 'openai', model: 'm1', usedModel: 'm1', status: 200, ms: 1 }, over);

  /* ---- flattenReq: 拍平成纯文本 ---- */

  await t('text 模式(默认): 输出纯文本, 去掉 JSON 结构与 thinking', () => {
    assert.strictEqual(REQ_MODE, 'text', '前置条件: 默认 text 模式');
    const s = flattenReq(chatReq());
    assert.strictEqual(typeof s, 'string', '拍平结果为字符串');
    for (const junk of ['"role"', '"content"', 'SYS-PROMPT"', 'THINKING-TRACE-1', 'THINKING-TRACE-2']) {
      assert.ok(!s.includes(junk), `不应包含 JSON 键/转义/thinking: ${junk}`);
    }
    assert.ok(!s.includes('call_a1'), '不应包含 tool_call UUID');
    for (const want of ['[system] SYS-PROMPT', '[user] 上海天气', '[assistant] 我查一下', '[assistant] 上海 25 度']) {
      assert.ok(s.includes(want), `应保留正文: ${want}`);
    }
  });

  await t('text 模式: tool_call 与 tool 结果用序号配对, 保留因果链', () => {
    const s = flattenReq(chatReq());
    assert.ok(s.includes('tool_call #1 weather {"city":"上海"}'), 'tool_call 行含名称与参数');
    assert.ok(s.includes('[tool] #1 weather {"temp":25}'), 'tool 结果行回指同一序号');
  });

  await t('text 模式: 顶层参数压成一行, tools 定义折叠为数量', () => {
    const s = flattenReq(chatReq());
    assert.ok(s.startsWith('请求参数: '), '参数行在开头');
    assert.ok(s.includes('model=m1') && s.includes('max_completion_tokens=1024'), '保留标量参数');
    assert.ok(s.includes('include_usage'), '对象参数以 JSON 表示, 不是 [object Object]');
    assert.ok(!s.includes('[object Object]'), '不应出现 [object Object]');
    assert.ok(s.includes('tools=1个'), 'tools 定义折叠为数量');
    assert.ok(!s.includes('parameters'), 'tools 的 JSON Schema 定义不保留');
  });

  await t('text-ask 模式: 只留 system/user 消息', () => {
    const m = loadProxy({ REQUESTS_REQ_MODE: 'text-ask' });
    const s = m.flattenReq(chatReq());
    assert.ok(s.includes('[system] SYS-PROMPT') && s.includes('[user] 上海天气'), '保留提问内容');
    assert.ok(!s.includes('我查一下') && !s.includes('25 度'), 'assistant 回复不保留');
    assert.ok(!s.includes('{"temp":25}'), 'tool 结果不保留');
  });

  await t('json 模式: 保留原始对象结构(可切换回旧行为)', () => {
    const m = loadProxy({ REQUESTS_REQ_MODE: 'json' });
    const s = m.flattenReq(chatReq());
    assert.ok(s.includes('"role":"system"') && s.includes('THINKING-TRACE-1'), '保留完整 JSON 与 thinking');
    assert.ok(s.startsWith('{') && s.endsWith('}'), '仍是 JSON 对象');
  });

  await t('非法/非消息结构: 原样 JSON 返回, 不抛错', () => {
    assert.strictEqual(flattenReq({ model: 'm1' }), '{"model":"m1"}', '无 messages 时原样 JSON');
    assert.strictEqual(flattenReq('raw-string'), '"raw-string"', '非对象时 JSON 串');
    assert.strictEqual(flattenReq(null), 'null', 'null 安全');
    const circ = { model: 'm1' };
    circ.self = circ;
    assert.throws(() => flattenReq(circ), '循环引用仍抛错(由 finalizeRec 捕获)');
  });

  /* ---- finalizeRec: 截断与落盘形态 ---- */

  await t('请求体未超限: 拍平为纯文本, 无截断标记', () => {
    assert.strictEqual(MAX_REQ, 4000, '前置条件: 上限注入生效');
    const r = finalizeRec(rec({ req: chatReq(), res: 'ok' }));
    assert.ok(!r.reqTruncated, '不应标记 reqTruncated');
    assert.strictEqual(typeof r.req, 'string', 'req 为拍平后的文本');
    assert.ok(r.req.includes('[user] 上海天气'), '正文可读');
    assert.ok(!r.req.includes('THINKING-TRACE'), 'thinking 不保留');
    assert.ok(Number.isInteger(r.ms) && r.ms >= 0, '耗时已填充(毫秒)');
  });

  await t('请求体超限: 截断保留前缀 + reqTruncated + reqSize(原始 JSON 字节数)', () => {
    const big = { model: 'm1', messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'x'.repeat(20000) }] };
    const rawLen = JSON.stringify(big).length;
    const r = finalizeRec(rec({ req: big, res: 'ok' }));
    assert.strictEqual(r.reqTruncated, true, '应标记 reqTruncated');
    assert.strictEqual(r.reqSize, Buffer.byteLength(JSON.stringify(big)), 'reqSize 记录原始字节数');
    assert.ok(rawLen > MAX_REQ, `前置条件: 原始长度 ${rawLen} > 上限 ${MAX_REQ}`);
    assert.ok(r.req.length <= MAX_REQ + MARK.length, `截断后长度 ${r.req.length} 不应超过上限 + 标记`);
    assert.ok(r.req.endsWith(MARK), '末尾带截断标记');
    assert.ok(r.req.startsWith('请求参数: '), '保留的是拍平文本的前缀');
    assert.ok(r.req.includes('[system] SYS'), '前缀内容(system prompt)仍可读到');
  });

  await t('中文请求体超限: 截断点不产生半字符乱码', () => {
    const big = { model: 'm1', messages: [{ role: 'user', content: '汉'.repeat(8000) }] };
    const r = finalizeRec(rec({ req: big, res: 'ok' }));
    assert.strictEqual(r.reqTruncated, true);
    const body = r.req.slice(0, r.req.length - MARK.length);
    assert.ok(body.length > 0 && body.length <= MAX_REQ, `截断后字符数 ${body.length} 应在上限内`);
    // UTF-8 每字符 1-4 字节: 字符数截断保证不会落在多字节字符中间
    assert.ok(Buffer.byteLength(body) <= 4 * MAX_REQ, '字节数不应显著超上限');
    assert.ok(!/\uFFFD/.test(body), '不应出现替换字符(半字符)');
    assert.strictEqual(r.reqSize, Buffer.byteLength(JSON.stringify(big)), 'reqSize 为原始字节数');
  });

  await t('拍平后体积显著小于原始 JSON', () => {
    const big = {
      model: 'm1', tools: [{ type: 'function', function: { name: 't', parameters: { type: 'object', properties: { a: { type: 'string' } } } } }],
      messages: [
        { role: 'user', content: 'u'.repeat(5000) },
        { role: 'assistant', content: 'a'.repeat(5000), reasoning_content: 't'.repeat(5000) },
      ],
    };
    const before = Buffer.byteLength(JSON.stringify(big));
    const after = Buffer.byteLength(flattenReq(big));
    assert.ok(after < before * 0.7, `拍平后 ${after}B 应明显小于原始 ${before}B`);
  });

  await t('JSON.stringify 失败(循环引用): req 置空并标记', () => {
    const circ = { model: 'm1' };
    circ.self = circ;
    const r = finalizeRec(rec({ req: circ, res: 'ok' }));
    assert.strictEqual(r.req, null, '不可串化的请求体置空');
    assert.strictEqual(r.reqTruncated, true, '标记为截断');
  });

  await t('响应体超限: 保持原行为(truncated + 按字符截断)', () => {
    const r = finalizeRec(rec({ req: { model: 'm1' }, res: 'y'.repeat(5000) }));
    assert.strictEqual(r.truncated, true);
    assert.strictEqual(r.res.length, MAX_REC, `响应截断到上限 ${MAX_REC}`);
    assert.ok(!r.reqTruncated, '请求体小, 不受影响');
  });

  await t('响应体未超限: 完整保留', () => {
    const r = finalizeRec(rec({ req: { model: 'm1' }, res: 'hello' }));
    assert.ok(!r.truncated);
    assert.strictEqual(r.res, 'hello');
  });

  await t('拍平后的 req 可被序列化并写入(不阻塞落盘路径)', () => {
    const r = finalizeRec(rec({ req: chatReq(), res: 'ok' }));
    const js = JSON.stringify(r);   // requests.log 会再做一次序列化
    assert.ok(js.length > 0, '记录可正常序列化');
    assert.strictEqual(r.resChunks, undefined, '内部字段已清理');
  });

  /* ---- 每次上游尝试单独落日志(保留全部调用记录, 含被重试的 429/5xx) ---- */

  await t('finalizeRec: 预设 ms 保留(中间尝试=本次耗时), 未预设按整次调用起算', () => {
    const r1 = finalizeRec(Object.assign({}, rec(), { t: Date.now() - 5000, ms: 0 }));
    assert.ok(r1.ms >= 5000, `未预设 ms 按调用起算(实际 ${r1.ms})`);
    const r2 = finalizeRec(Object.assign({}, rec(), { ms: 42 }));
    assert.strictEqual(r2.ms, 42, '预设 ms 保留不被覆盖');
  });

  await t('logAttempt: 被重试的尝试单独成行, final=false/attemptIdx/traceId 完整, 不带请求正文', () => {
    const captured = [];
    const origLog = requests.log;
    requests.log = (r) => { captured.push(r); };
    try {
      const parent = {
        t: Date.now(), provider: 'p', apiType: 'openai', model: 'm1',
        path: '/v1/chat/completions', method: 'POST', degraded: false, traceId: 'tr-abc',
      };
      const out = logAttempt(
        parent,
        { modelId: 'm2', key: 'sk-aaaaaaaaaaaabbb' },
        { status: 429, body: Buffer.from('{"error":{"message":"inference exceeds tpm/rpm limit"}}') },
        { kind: 'retry', reason: 'status:429' },
        1, Date.now() - 30,
      );
      assert.strictEqual(captured.length, 1, '中间尝试写入一条独立日志');
      assert.strictEqual(out.final, false, '标记为中间尝试');
      assert.strictEqual(out.attemptIdx, 1, '记录第几次尝试');
      assert.strictEqual(out.attempts, 1, 'attempts=当前已尝试次数');
      assert.strictEqual(out.usedModel, 'm2', '命中的 model');
      assert.strictEqual(out.key, 'sk-aaaaa…abbb', 'key 脱敏保留');
      assert.strictEqual(out.status, 429, '状态码');
      assert.strictEqual(out.reason, 'status:429', '失败原因分类');
      assert.strictEqual(out.traceId, 'tr-abc', '关联同一次客户端调用');
      assert.strictEqual(out.req, null, '中间尝试不重复携带请求正文');
      assert.ok(out.res.includes('tpm/rpm limit'), '保留上游错误片段');
      assert.ok(out.ms >= 0, '本次尝试耗时');
      assert.strictEqual(out.promptTokens, 0, '中间尝试不计 token(避免重复统计)');
    } finally { requests.log = origLog; }
  });

  await t('finalizeRec: final=false 不计入 ingress key 请求数(否则 reqs 按上游尝试数虚增)', () => {
    const keysMod = require('../src/keys');
    const origTouch = keysMod.touch;
    let calls = [];
    keysMod.touch = (id, n) => { calls.push([id, n]); };
    try {
      finalizeRec(Object.assign({}, rec(), { ingressKeyId: 'k1', final: false, promptTokens: 5, completionTokens: 3 }));
      assert.deepStrictEqual(calls, [], '中间尝试不 touch');
      finalizeRec(Object.assign({}, rec(), { ingressKeyId: 'k1', final: true, promptTokens: 5, completionTokens: 3 }));
      assert.deepStrictEqual(calls, [['k1', 8]], '最终记录 touch 一次, 计入 prompt+completion');
      finalizeRec(Object.assign({}, rec(), { final: undefined, promptTokens: 2, completionTokens: 1 }));
      assert.strictEqual(calls.length, 1, '无 ingressKeyId 不 touch');
    } finally { keysMod.touch = origTouch; }
  });

  console.log(`finalize.test: ${passes + 3} pass / ${failures} fail`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  return failures === 0;
};
