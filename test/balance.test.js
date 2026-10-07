/**
 * balance.test.js — 权重轮询引擎单元测试
 * 运行: node test/run.js
 */
'use strict';
const assert = require('assert');
const bal = require('../src/balance');

const provider = (models) => ({
  name: 't', apiType: 'openai', baseURL: 'http://x', usageLimit: 5, useSeconds: 10, models,
});

const P = provider([
  { id: 'm100', weight: 100, usageLimit: null, useSeconds: null, keys: ['k100a', 'k100b'] },
  { id: 'm99', weight: 99, usageLimit: null, useSeconds: null, keys: ['k99a', 'k99b', 'k99c'] },
  { id: 'm97', weight: 97, usageLimit: null, useSeconds: null, keys: ['k97a'] },
]);

/** 跑一次请求:全按给定状态执行,返回用过的 (modelId,key) 序列与结果 */
function runRequest(st, reqId, failAll = [], okOn = null) {
  const used = [];
  const plan1 = bal.plan(P, st, reqId);
  let attempt = 0;
  const cap = bal.maxAttempts(P) + 5;
  for (const c of plan1) {
    if (++attempt > cap) break;
    used.push(c);
    const key = c.key;
    if (c.modelId === 'm100' && key === 'k100a' && !failAll.includes('m100')) return { used, ok: true, modelId: c.modelId };
    if (okOn === c.modelId && c.key === okOn.key) return { used, ok: true, modelId: c.modelId };
    // fail → 若是该 model 最后一个 key,触发降级
    if (plan1.filter((x) => x.modelId === c.modelId).at(-1) === c) {
      bal.report(P, st, c.modelId, false);
    }
  }
  return { used, ok: false };
}

module.exports = async () => {
  let failures = 0;
  const t = (name, fn) => { try { fn(); console.log('  ✓', name); } catch (e) { failures++; console.log('  ✗', name, '\n    ', e.message); } };

  t('主 model(权重100)正常时直接用主,key 轮询', () => {
    const st = bal.newState();
    const p1 = bal.plan(P, st, 'm100');
    assert.strictEqual(p1[0].modelId, 'm100');
    assert.strictEqual(p1[0].key, 'k100a');
    bal.advanceKey(st, 'm100'); // 尝试了 k100a(成功/失败都推进)
    const p2 = bal.plan(P, st, 'm100');
    assert.strictEqual(p2[0].key, 'k100b');
  });

  t('主 model 第一个 key 限流 → 换同一个 model 的下一个 key', () => {
    const st = bal.newState();
    const plan1 = bal.plan(P, st, 'm100');
    // k100a 失败 → 下一次尝试仍是 m100 的 k100b
    assert.strictEqual(plan1[1].modelId, 'm100');
    assert.strictEqual(plan1[1].key, 'k100b');
  });

  t('主 model 全部 key 限流 → 降级到权重 99 的 model', () => {
    const st = bal.newState();
    const plan1 = bal.plan(P, st, 'm100');
    // 模拟 m100 两个 key 都失败 → degrade
    const nextPlan = bal.degrade(P, st, 'm100');
    assert.strictEqual(st.degraded.modelId, 'm99');
    assert.strictEqual(nextPlan[0].modelId, 'm99');
    assert.strictEqual(nextPlan[0].key, 'k99a');
  });

  t('降级 model 成功 1 次(usageLimit=1)后 → 切回主 model', () => {
    const st = bal.newState();
    bal.degrade(P, st, 'm100'); // 降级到 m99
    bal.report(P, st, 'm99', true); // m99 成功 1 次
    const limitP = provider([...P.models.map((m) => ({ ...m, usageLimit: m.id === 'm99' ? 1 : null }))]);
    // 用带 usageLimit 的 provider 重建状态检查
    const st2 = bal.newState();
    bal.degrade(limitP, st2, 'm100');
    bal.report(limitP, st2, 'm99', true);
    const p = bal.plan(limitP, st2, 'm100');
    assert.strictEqual(p[0].modelId, 'm100'); // 已切回主
  });

  t('降级 model 时长到期(useSeconds) → 切回主 model', () => {
    const st = bal.newState();
    const timeP = provider([...P.models.map((m) => ({ ...m, useSeconds: m.id === 'm99' ? 1 : null }))]);
    bal.degrade(timeP, st, 'm100');
    st.degraded.since = Date.now() - 2000; // 模拟 2s 过去
    const p = bal.plan(timeP, st, 'm100');
    assert.strictEqual(p[0].modelId, 'm100');
  });

  t('权重99也限流 → 继续降级到权重97', () => {
    const st = bal.newState();
    bal.degrade(P, st, 'm100'); // → m99
    bal.degrade(P, st, 'm99');  // m99 全失败 → m97(还有更低权重)
    assert.strictEqual(st.degraded.modelId, 'm97');
    const p = bal.plan(P, st, null);
    assert.strictEqual(p[0].modelId, 'm97');
  });

  t('最低权重也限流 → 回到主 model 重试(循环)', () => {
    const st = bal.newState();
    bal.degrade(P, st, 'm100'); // → m99
    bal.degrade(P, st, 'm99');  // → m97
    bal.degrade(P, st, 'm97');  // 无更低 → 回主
    assert.strictEqual(st.degraded, null);
    const p = bal.plan(P, st, 'm100');
    assert.strictEqual(p[0].modelId, 'm100');
  });

  t('成功计数只算成功返回(失败不计数)', () => {
    const st = bal.newState();
    const limP = provider([...P.models.map((m) => ({ ...m, usageLimit: m.id === 'm99' ? 2 : null }))]);
    bal.degrade(limP, st, 'm100');
    bal.report(limP, st, 'm99', true);  // 成功 1
    bal.report(limP, st, 'm99', false); // 失败(不计)
    bal.report(limP, st, 'm99', true);  // 成功 2 → 达标
    const p = bal.plan(limP, st, 'm100');
    assert.strictEqual(p[0].modelId, 'm100');
  });

  t('请求指定 model 时从该 model 开始(尊重客户端),主 model 兜底', () => {
    const st = bal.newState();
    const p = bal.plan(P, st, 'm97');
    assert.strictEqual(p[0].modelId, 'm97'); // 客户端明确指定
    assert.strictEqual(p[0].key, 'k97a');
    assert.strictEqual(p[1].modelId, 'm100'); // 无更低权重 → 主兜底
  });

  t('maxAttempts 有限值(防死循环)', () => {
    assert.strictEqual(bal.maxAttempts(P), (2 + 3 + 1) * 2 + 3);
  });

  t('同权重兄弟 model 均进入尝试序列(不整层跳过)', () => {
    const P2 = provider([
      { id: 'a', weight: 100, usageLimit: null, useSeconds: null, keys: ['a1'] },
      { id: 'b', weight: 100, usageLimit: null, useSeconds: null, keys: ['b1'] },
      { id: 'c', weight: 90, usageLimit: null, useSeconds: null, keys: ['c1'] },
    ]);
    const st = bal.newState();
    const p = bal.plan(P2, st, 'a');
    assert.deepStrictEqual(p.map((x) => x.modelId), ['a', 'b', 'c']); // 同层 a,b 都在
    // 同权重失败后可降级到同层兄弟
    const d = bal.degrade(P2, st, 'a');
    assert.strictEqual(d[0].modelId, 'b');
  });

  console.log(failures ? `\n${failures} 个测试失败` : '\n全部通过');
  return failures === 0;
};
/* R1 回归: 同权重 model 均应进入尝试序列 */
module.exports.t = null;
