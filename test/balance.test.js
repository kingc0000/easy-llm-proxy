/**
 * balance.test.js — 权重轮询引擎单元测试
 * per-key 降级链 / 轮转队列+冷却跳过 / per-(model,key) 冷却 / roundRobin
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
// allKeys 展开顺序: k100a, k100b, k99a, k99b, k99c, k97a (6 个)

module.exports = async () => {
  let failures = 0;
  const t = (name, fn) => { try { fn(); console.log('  ✓', name); } catch (e) { failures++; console.log('  ✗', name, '\n    ', e.message); } };

  t('主 model(权重100)正常时直接用主;失败 key 冷却 + 指针轮转(下次从它下一个起)', () => {
    const st = bal.newState();
    const p1 = bal.plan(P, st, 'm100');
    assert.strictEqual(p1[0].modelId, 'm100');
    assert.strictEqual(p1[0].key, 'k100a');
    bal.advanceKey(st, 'm100', 'k100a'); // k100a 失败 → 冷却 + 指针前进
    const p2 = bal.plan(P, st, 'm100');
    assert.strictEqual(p2[0].key, 'k100b'); // 从 k100a 下一个起
    assert.ok(!p2.some((c) => c.modelId === 'm100' && c.key === 'k100a')); // 冷却中被跳过
  });

  t('主 model 第一个 key 限流 → 换同一个 model 的下一个 key', () => {
    const st = bal.newState();
    const plan1 = bal.plan(P, st, 'm100');
    assert.strictEqual(plan1[1].modelId, 'm100');
    assert.strictEqual(plan1[1].key, 'k100b');
  });

  t('主 model 全部 key 限流 → degrade 后 per-key 降级态指向权重 99', () => {
    const st = bal.newState();
    bal.advanceKey(st, 'm100', 'k100a'); // 真实流程: 失败先进冷却
    bal.advanceKey(st, 'm100', 'k100b');
    const r = bal.degrade(P, st, 'm100', ['k100a', 'k100b']);
    assert.strictEqual(r.toModel, 'm99');
    assert.strictEqual(st.degraded.get('k100a').modelId, 'm99');
    assert.strictEqual(st.degraded.get('k100b').modelId, 'm99');
    const p = bal.plan(P, st, 'm100');
    assert.strictEqual(p.find((c) => c.key === 'k100a').modelId, 'm99'); // 主冷却中的降级 key 候选移到 m99
    assert.strictEqual(p[0].modelId, 'm100'); // 未降级 key 仍主层优先
    assert.strictEqual(p[0].key, 'k99a');
  });

  t('降级 model 成功 1 次(usageLimit=1)后 → 切回主 model', () => {
    const limP = provider(P.models.map((m) => ({ ...m, usageLimit: m.id === 'm99' ? 1 : null })));
    const st = bal.newState();
    bal.advanceKey(st, 'm100', 'k100a'); // 失败先进冷却
    bal.advanceKey(st, 'm100', 'k100b');
    bal.degrade(limP, st, 'm100', ['k100a', 'k100b']); // 主冷却中 → 降级 m99
    bal.report(limP, st, 'm99', 'k100a', true); // k100a 成功 1 → 达限
    const pMid = bal.plan(limP, st, 'm100');
    assert.strictEqual(pMid.find((c) => c.key === 'k100a').modelId, 'm99'); // k100b 未达限 → 整层不切
    bal.report(limP, st, 'm99', 'k100b', true); // k100b 也达限 → 整层可切
    st.failAt.set('m100\u0000k100a', Date.now() - 61 * 1000); // 主已过冷却
    st.failAt.set('m100\u0000k100b', Date.now() - 61 * 1000);
    const p = bal.plan(limP, st, 'm100');
    assert.strictEqual(p.find((c) => c.key === 'k100a').modelId, 'm100'); // 整层回主
    assert.strictEqual(p.find((c) => c.key === 'k100b').modelId, 'm100');
  });

  t('降级 model 时长到期(useSeconds) → 切回主 model', () => {
    const timeP = provider(P.models.map((m) => ({ ...m, useSeconds: m.id === 'm99' ? 1 : null })));
    const st = bal.newState();
    bal.advanceKey(st, 'm100', 'k100a'); // 失败先进冷却
    bal.degrade(timeP, st, 'm100', ['k100a']); // 主冷却中 → 降级 m99
    st.degraded.get('k100a').since = Date.now() - 2000; // 模拟 2s 过去(限 1s)
    st.failAt.set('m100\u0000k100a', Date.now() - 61 * 1000); // 主已过冷却
    const p = bal.plan(timeP, st, 'm100');
    assert.strictEqual(p[0].modelId, 'm100');
  });

  t('权重99也限流 → 继续降级到权重97(更深链式降级)', () => {
    const st = bal.newState();
    bal.advanceKey(st, 'm100', 'k100a');
    bal.advanceKey(st, 'm100', 'k100b');
    bal.degrade(P, st, 'm100', ['k100a', 'k100b']); // → m99
    bal.advanceKey(st, 'm99', 'k100a');
    bal.advanceKey(st, 'm99', 'k100b');
    const r = bal.degrade(P, st, 'm99', ['k100a', 'k100b']); // m99 全失败 → 更低层 m97
    assert.strictEqual(r.toModel, 'm97');
    assert.strictEqual(st.degraded.get('k100a').modelId, 'm97');
    const p = bal.plan(P, st, null);
    assert.strictEqual(p.find((c) => c.key === 'k100a').modelId, 'm97'); // 主冷却中 → 从 m97 起
    assert.strictEqual(p[0].modelId, 'm100'); // 未降级 key 仍主优先
  });

  t('最低权重也限流 → 兜底回主 model 重试(循环)', () => {
    const st = bal.newState();
    bal.advanceKey(st, 'm100', 'k100a');
    bal.degrade(P, st, 'm100', ['k100a']); // 主冷却中 → m99
    bal.advanceKey(st, 'm99', 'k100a');
    bal.degrade(P, st, 'm99', ['k100a']);  // 主仍冷却 → m97
    bal.advanceKey(st, 'm97', 'k100a');
    const r = bal.degrade(P, st, 'm97', ['k100a']); // 已是最低 → 清态回主
    assert.strictEqual(r.toModel, null);
    assert.strictEqual(r.cleared, 1);
    assert.ok(!st.degraded.has('k100a'));
    const p = bal.plan(P, st, 'm100');
    assert.strictEqual(p[0].modelId, 'm100');
  });

  t('成功计数只算成功返回(失败不计数)', () => {
    const limP = provider(P.models.map((m) => ({ ...m, usageLimit: m.id === 'm99' ? 2 : null })));
    const st = bal.newState();
    bal.advanceKey(st, 'm100', 'k100a'); // 主对该 key 冷却中
    bal.degrade(limP, st, 'm100', ['k100a']);  // → m99
    bal.report(limP, st, 'm99', 'k100a', true);  // 成功 1
    bal.report(limP, st, 'm99', 'k100a', false); // 失败(不计)
    assert.strictEqual(st.degraded.get('k100a').success, 1);
    bal.report(limP, st, 'm99', 'k100a', true);  // 成功 2 → 达标
    st.failAt.set('m100\u0000k100a', Date.now() - 61 * 1000); // 主已过冷却
    const p = bal.plan(limP, st, 'm100');
    assert.strictEqual(p[0].modelId, 'm100'); // 降级期用完+主过冷却 → 回主
  });

  t('请求指定 model 时从该 model 开始(所有 key 均从其链起点)', () => {
    const st = bal.newState();
    const p = bal.plan(P, st, 'm97');
    assert.strictEqual(p[0].modelId, 'm97');
    assert.strictEqual(p[0].key, 'k100a');
    assert.strictEqual(p.length, 6);
    assert.ok(p.every((c) => c.modelId === 'm97'));
  });

  t('maxAttempts 有限值(防死循环)', () => {
    assert.strictEqual(bal.maxAttempts(P), 24); // ks=6 × models=3 + 6
  });

  t('同权重兄弟 model 均进入尝试序列(不整层跳过)', () => {
    const P2 = provider([
      { id: 'a', weight: 100, usageLimit: null, useSeconds: null, keys: ['a1'] },
      { id: 'b', weight: 100, usageLimit: null, useSeconds: null, keys: ['b1'] },
      { id: 'c', weight: 90, usageLimit: null, useSeconds: null, keys: ['c1'] },
    ]);
    const st = bal.newState();
    const p = bal.plan(P2, st, 'a');
    assert.deepStrictEqual(p.map((x) => x.modelId), ['a', 'a', 'a', 'c', 'c', 'c']);
    bal.advanceKey(st, 'a', 'a1'); // 主对该 key 冷却中
    const r = bal.degrade(P2, st, 'a', ['a1']);
    assert.strictEqual(r.toModel, 'b'); // 同权重兄弟优先降级
    assert.strictEqual(st.degraded.get('a1').modelId, 'b');
  });

  t('超限轮询: 失败 key 冷却期内被跳过,过期后重新可用(不抢队首)', () => {
    const st = bal.newState();
    bal.advanceKey(st, 'm100', 'k100a'); // k100a 失败 → 冷却
    const p1 = bal.plan(P, st, 'm100');
    assert.ok(!p1.some((c) => c.modelId === 'm100' && c.key === 'k100a')); // 冷却中跳过
    // 冷却过期
    st.failAt.set('m100\u0000k100a', Date.now() - 61 * 1000);
    const p2 = bal.plan(P, st, 'm100');
    assert.ok(p2.some((c) => c.modelId === 'm100' && c.key === 'k100a')); // 重新可用
    assert.strictEqual(p2[0].key, 'k100b'); // 但指针已过,不抢回队首(等排其后的 key 也限流)
  });

  t('冷却粒度 (model,key): 主 model 冷却不影响该 key 在低权重的可用性', () => {
    const st = bal.newState();
    bal.advanceKey(st, 'm100', 'k100a');
    bal.advanceKey(st, 'm100', 'k100b');
    const p = bal.plan(P, st, 'm100');
    // 主 model(m100) 对这两个 key 的候选被跳过
    assert.ok(!p.some((c) => c.modelId === 'm100' && (c.key === 'k100a' || c.key === 'k100b')));
    // 但同一 key 在 m99 层仍可用(model 级限流,key1 换 model 后不受影响)
    assert.ok(p.some((c) => c.modelId === 'm99' && c.key === 'k100a'));
    assert.ok(p.some((c) => c.modelId === 'm99' && c.key === 'k100b'));
  });

  t('冷却时长三层: model.cooldown / key 覆盖 / 全局默认', () => {
    // 模拟 config.js 归一化后的结构: keys 字符串数组 + keyCooldowns(秒)
    const CP = provider([
      { id: 'm100', weight: 100, usageLimit: null, useSeconds: null, cooldown: 10, keys: ['k1', 'k2'], keyCooldowns: { k2: 5 } },
    ]);
    const st = bal.newState();
    // k2 冷却 5s: 刚失败 → 跳过
    bal.advanceKey(st, 'm100', 'k2');
    assert.ok(!bal.plan(CP, st, 'm100').some((c) => c.key === 'k2'));
    // 5s+ 后可用
    st.failAt.set('m100\u0000k2', Date.now() - 6 * 1000);
    assert.ok(bal.plan(CP, st, 'm100').some((c) => c.key === 'k2'));
    // k1 走 model.cooldown 10s
    bal.advanceKey(st, 'm100', 'k1');
    assert.ok(!bal.plan(CP, st, 'm100').some((c) => c.key === 'k1'));
    st.failAt.set('m100\u0000k1', Date.now() - 11 * 1000);
    assert.ok(bal.plan(CP, st, 'm100').some((c) => c.key === 'k1')); // 10s 已过可用
    // 无 cooldown 配置的 model → 全局默认 60s
    const st2 = bal.newState();
    bal.advanceKey(st2, 'm100', 'k100a');
    assert.ok(!bal.plan(P, st2, 'm100').some((c) => c.modelId === 'm100' && c.key === 'k100a'));
    st2.failAt.set('m100\u0000k100a', Date.now() - 61 * 1000);
    assert.ok(bal.plan(P, st2, 'm100').some((c) => c.modelId === 'm100' && c.key === 'k100a'));
  });

  t('平均轮询(roundRobin=true): 每请求严格轮换到下一个 key', () => {
    const RP = { ...P, roundRobin: true };
    const st = bal.newState();
    const p1 = bal.plan(RP, st, 'm100');
    assert.strictEqual(p1[0].key, 'k100a');
    bal.report(RP, st, 'm100', 'k100a', true); // lastKey=k100a
    const p2 = bal.plan(RP, st, 'm100');
    assert.strictEqual(p2[0].key, 'k100b');
    bal.report(RP, st, 'm100', 'k100b', true); // lastKey=k100b
    const p3 = bal.plan(RP, st, 'm100');
    assert.strictEqual(p3[0].key, 'k99a');
  });

  t('主 model 全 key 限流 → 冷却期间降级用备2(不提前回主)', () => {
    const st = bal.newState();
    const allK = ['k100a', 'k100b', 'k99a', 'k99b', 'k99c', 'k97a'];
    for (const k of allK) bal.advanceKey(st, 'm100', k);
    bal.degrade(P, st, 'm100', allK);
    const p1 = bal.plan(P, st, null);
    assert.ok(!p1.some((c) => c.modelId === 'm100'), '主冷却期内不尝试主');
    assert.strictEqual(p1[0].modelId, 'm99'); // 主层为空 → 直接备2
    // 主 model 冷却过期,但降级期(usageLimit/useSeconds)还没用完 → 仍留在备2,不回主
    for (const k of allK) st.failAt.set('m100\0' + k, Date.now() - 61 * 1000);
    const p2 = bal.plan(P, st, null);
    assert.strictEqual(p2[0].modelId, 'm99'); // 降级期未用完 → 继续用备2
  });

  t('降级期用完且主已过冷却 → 回主;主仍冷却 → 下探到下一 model', () => {
    const limP = provider(P.models.map((m) => ({ ...m, usageLimit: m.id === 'm99' ? 2 : null })));
    // 场景 A: 降级期用完 + 主已过冷却 → 回主
    const stA = bal.newState();
    bal.advanceKey(stA, 'm100', 'k100a');
    bal.degrade(limP, stA, 'm100', ['k100a']); // → m99
    bal.report(limP, stA, 'm99', 'k100a', true); // 成功 1
    bal.report(limP, stA, 'm99', 'k100a', true); // 成功 2 → 达限
    stA.failAt.set('m100\0k100a', Date.now() - 61 * 1000); // 主已过冷却
    const pA = bal.plan(limP, stA, null);
    assert.strictEqual(pA.find((c) => c.key === 'k100a').modelId, 'm100'); // 回主
    // 场景 B: 降级期用完 + 主仍在冷却 → 下探到 m97
    const stB = bal.newState();
    bal.advanceKey(stB, 'm100', 'k100a');
    bal.degrade(limP, stB, 'm100', ['k100a']); // → m99
    bal.report(limP, stB, 'm99', 'k100a', true); // 成功 1
    bal.report(limP, stB, 'm99', 'k100a', true); // 成功 2 → 达限(主冷却未过期)
    const pB = bal.plan(limP, stB, null);
    assert.strictEqual(pB.find((c) => c.key === 'k100a').modelId, 'm97'); // 主仍冷却 → m3
  });

  t('降级中限流: 主未冷却 → 回主重试;主仍冷却 → 下探下一层', () => {
    const st = bal.newState();
    // 场景 A: k100a 降级到 m99,此刻 m99 限流,但主 m100 已过冷却 → 回主
    bal.advanceKey(st, 'm100', 'k100a');
    bal.advanceKey(st, 'm100', 'k100b');
    bal.degrade(P, st, 'm100', ['k100a', 'k100b']); // → m99
    st.failAt.set('m100\0k100a', Date.now() - 61 * 1000); // 主对该 key 已过冷却
    bal.advanceKey(st, 'm99', 'k100a'); // m99 限流
    const dgA = bal.degrade(P, st, 'm99', ['k100a']);
    assert.ok(!st.degraded.has('k100a'), '主已过冷却 → 清降级回主');
    assert.ok(st.degraded.has('k100b')); // 另一个 key 主仍冷却 → 保持降级
    assert.strictEqual(dgA.toModel, null); // 回主路径 toModel=null
    assert.strictEqual(dgA.cleared, 1);
    // 场景 B: k100b 的主仍在冷却,m99 限流 → 下探 m97
    bal.advanceKey(st, 'm99', 'k100b');
    const dgB = bal.degrade(P, st, 'm99', ['k100b']);
    assert.strictEqual(st.degraded.get('k100b').modelId, 'm97'); // 主仍冷却 → m3
    assert.strictEqual(dgB.toModel, 'm97');
  });

  t('备2 也全限流且主仍冷却 → 落备3;降级期用完且主过冷却 → 回主', () => {
    const secP = provider(P.models.map((m) => ({ ...m, useSeconds: m.id === 'm97' ? 10 : null })));
    const st = bal.newState();
    const allK = ['k100a', 'k100b', 'k99a', 'k99b', 'k99c', 'k97a'];
    for (const k of allK) { bal.advanceKey(st, 'm100', k); bal.advanceKey(st, 'm99', k); }
    bal.degrade(secP, st, 'm100', allK);
    bal.degrade(secP, st, 'm99', allK); // → m97
    const p1 = bal.plan(secP, st, null);
    assert.ok(p1.every((c) => c.modelId === 'm97'), '主与备2 都冷却 → 只试备3');
    // 降级期用完(useSeconds)且主已过冷却 → 回主
    for (const k of allK) st.degraded.get(k).since = Date.now() - 11 * 1000; // 限 10s,已过
    for (const k of allK) st.failAt.set('m100\0' + k, Date.now() - 61 * 1000);
    const p2 = bal.plan(secP, st, null);
    assert.strictEqual(p2[0].modelId, 'm100'); // 降级期用完 + 主过冷却 → 回主优先
  });

  t('层切换必须整层: 部分 key 主已过冷却也不单独回主(整层统一切换)', () => {
    const st = bal.newState();
    bal.advanceKey(st, 'm100', 'k100a');
    bal.advanceKey(st, 'm100', 'k100b');
    bal.advanceKey(st, 'm100', 'k99a');
    bal.degrade(P, st, 'm100', ['k100a', 'k100b', 'k99a']); // → m99
    st.failAt.set('m100\u0000k100a', Date.now() - 61 * 1000); // 仅 k100a 的主过冷却
    const dg = bal.degrade(P, st, 'm99', ['k100a', 'k100b', 'k99a']); // m99 整层耗尽
    assert.strictEqual(dg.toModel, 'm97'); // 并非整层主都过冷却 → 整层下探 m97
    assert.strictEqual(st.degraded.get('k100a').modelId, 'm97'); // k100a 不单独回主
    assert.strictEqual(st.degraded.get('k100b').modelId, 'm97');
    assert.strictEqual(st.degraded.get('k99a').modelId, 'm97');
  });

  t('主 model 成功 → 兜底解除该 key 降级(防御性;正常流程降级 key 不进入主层)', () => {
    const st = bal.newState();
    bal.advanceKey(st, 'm100', 'k100a');
    bal.degrade(P, st, 'm100', ['k100a']);
    assert.ok(st.degraded.has('k100a'));
    bal.report(P, st, 'm100', 'k100a', true); // 主成功(防御路径)
    assert.ok(!st.degraded.has('k100a'));     // 降级解除
    assert.ok(!st.failAt.has('m100\0k100a')); // 成功解除冷却
    const p = bal.plan(P, st, null);
    assert.strictEqual(p.find((c) => c.key === 'k100a').modelId, 'm100');
  });

  console.log(failures ? `\n${failures} 个测试失败` : '\n全部通过');
  return failures === 0;
};